import type { AgentDeps, AgentSessionHandle } from "../../../third-party/cindy-agent/maker-core/agents/base-agent.js";
import type {
  InteractionDecision,
  InteractionRequest,
  UsageSnapshot,
} from "../../../third-party/cindy-agent/maker-core/types/events.js";
import type { Logger } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";
import { parseInFrame, stringifyOutFrame, type InFrame, type OutFrame } from "./protocol.js";
import { translateBridgeEvent } from "./translator.js";

/** v0 permission 等待超时：只做失败传播（拒绝 + 非终止 error 帧），不自动放行。 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

export function resolvePermissionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CINDY_BRIDGE_PERMISSION_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_PERMISSION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERMISSION_TIMEOUT_MS;
}

/**
 * agent 最小结构形状：v0 只用 `startSession`。`ClaudeCodeAgent` 结构满足，
 * 测试用假句柄注入（不走真实 SDK）。
 */
export interface BridgeAgent {
  startSession(opts: {
    sessionId?: string;
    workingDir: string;
    model: string;
    makerMemoryEnabled?: boolean;
  }): Promise<AgentSessionHandle>;
}

export interface BridgeOptions {
  createAgent: (deps: AgentDeps) => BridgeAgent;
  deps: AgentDeps;
  logger: Logger;
  permissionTimeoutMs?: number;
  /** 出帧接收器；默认写 stdout（生产），测试注入数组。 */
  emit?: (line: string) => void | Promise<void>;
}

interface PendingPermission {
  resolve: (decision: InteractionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeSession {
  handle: AgentSessionHandle;
  toolNames: Map<string, string>;
  pending: Map<string, PendingPermission>;
  pump: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * v0 bridge 主机：单 agent 实例 + `session → handle` 表 + 事件泵 + permission 挂起。
 *
 * 状态所有者仍是 Rust `AgentManager`；bridge 只持有活着的 SDK handle，
 * 重启后按 SDK resume 语义重建，不另存任务（spec §2）。
 */
export class CindyBridge {
  private agent: BridgeAgent | null = null;
  private readonly sessions = new Map<string, BridgeSession>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly permissionTimeoutMs: number;

  constructor(private readonly opts: BridgeOptions) {
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  private emitFrame(frame: OutFrame): void {
    const line = stringifyOutFrame(frame);
    this.writeQueue = this.writeQueue
      .then(() => this.opts.emit?.(line))
      .then(
        () => undefined,
        (err: unknown) => {
          this.opts.logger.error("bridge: emit frame failed", { error: errorText(err) });
        },
      );
  }

  /** 等所有已排队的出帧写完（测试用；生产 STDIO 路径不需要调）。 */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private ensureAgent(): BridgeAgent {
    if (!this.agent) {
      this.agent = this.opts.createAgent(this.opts.deps);
    }
    return this.agent;
  }

  async handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    const frame = parseInFrame(line);
    if (!frame) {
      this.opts.logger.warn("bridge: ignoring malformed line");
      return;
    }
    switch (frame.type) {
      case "start":
        await this.onStart(frame);
        break;
      case "prompt":
        await this.onPrompt(frame);
        break;
      case "respond":
        this.onRespond(frame);
        break;
      case "cancel":
        await this.onCancel(frame);
        break;
      case "close":
        await this.onClose(frame);
        break;
    }
  }

  private async onStart(frame: Extract<InFrame, { type: "start" }>): Promise<void> {
    const { session, cwd, model } = frame;
    if (this.sessions.has(session)) {
      this.emitFrame({ type: "error", session, message: `session already exists: ${session}`, terminal: true });
      return;
    }
    if (!model || model.length === 0) {
      // 中文注释：model 缺席直接报错，不静默选模型（spec §2）。模型由 cindy.toml
      // 默认值经 Rust 侧供给，bridge 不做任何兜底选择。
      this.emitFrame({ type: "error", session, message: "model is required in start frame", terminal: true });
      return;
    }
    let handle: AgentSessionHandle;
    try {
      handle = await this.ensureAgent().startSession({
        sessionId: session,
        workingDir: cwd,
        model,
        makerMemoryEnabled: false,
      });
    } catch (err) {
      this.emitFrame({ type: "error", session, message: `start failed: ${errorText(err)}`, terminal: true });
      return;
    }
    const record: BridgeSession = { handle, toolNames: new Map(), pending: new Map(), pump: Promise.resolve() };
    this.sessions.set(session, record);
    handle.setInteractionResolver((req) => this.resolveInteraction(session, req));
    record.pump = this.pumpSession(session, record);
    this.emitFrame({ type: "started", session, sdkSessionId: handle.id });
  }

  private async pumpSession(session: string, record: BridgeSession): Promise<void> {
    try {
      for await (const event of record.handle.events()) {
        if (event.type === "tool_use") {
          const data = isRecord(event.data) ? event.data : {};
          if (typeof data.toolUseId === "string" && typeof data.toolName === "string") {
            record.toolNames.set(data.toolUseId, data.toolName);
          }
        }
        let usage: UsageSnapshot | undefined;
        if (event.type === "done") {
          try {
            usage = record.handle.getUsageSnapshot();
          } catch (err) {
            this.opts.logger.warn("bridge: getUsageSnapshot failed, done frame without usage", {
              session,
              error: errorText(err),
            });
          }
        }
        for (const out of translateBridgeEvent(session, event, record.toolNames, usage)) {
          this.emitFrame(out);
        }
      }
    } catch (err) {
      // 事件迭代器抛错 = 传输层已死，会话不可再用：清表，Rust 侧标错（B3 保留 entries）。
      this.sessions.delete(session);
      this.emitFrame({ type: "error", session, message: `event stream failed: ${errorText(err)}`, terminal: true });
      try {
        await record.handle.close();
      } catch {
        // 关闭失败无妨，会话已从表中移除。
      }
    }
  }

  private async onPrompt(frame: Extract<InFrame, { type: "prompt" }>): Promise<void> {
    const record = this.sessions.get(frame.session);
    if (!record) {
      this.emitFrame({ type: "error", session: frame.session, message: `unknown session: ${frame.session}` });
      return;
    }
    try {
      await record.handle.send(
        { type: "user", content: frame.text },
        frame.messageUuid ? { messageUuid: frame.messageUuid } : undefined,
      );
    } catch (err) {
      this.emitFrame({
        type: "error",
        session: frame.session,
        message: `prompt rejected: ${errorText(err)}`,
        terminal: true,
      });
    }
  }

  private onRespond(frame: Extract<InFrame, { type: "respond" }>): void {
    const record = this.sessions.get(frame.session);
    if (!record) {
      this.emitFrame({ type: "error", session: frame.session, message: `unknown session: ${frame.session}` });
      return;
    }
    const pending = record.pending.get(frame.permissionId);
    if (!pending) {
      this.emitFrame({
        type: "error",
        session: frame.session,
        message: `unknown permission: ${frame.permissionId}`,
        terminal: false,
      });
      return;
    }
    record.pending.delete(frame.permissionId);
    clearTimeout(pending.timer);
    const decision: InteractionDecision = { kind: "permission", behavior: frame.decision };
    if (frame.updatedInput !== undefined) decision.updatedInput = frame.updatedInput;
    pending.resolve(decision);
  }

  private async onCancel(frame: Extract<InFrame, { type: "cancel" }>): Promise<void> {
    const record = this.sessions.get(frame.session);
    if (!record) {
      this.emitFrame({ type: "error", session: frame.session, message: `unknown session: ${frame.session}` });
      return;
    }
    try {
      await record.handle.abort();
    } catch (err) {
      this.emitFrame({
        type: "error",
        session: frame.session,
        message: `cancel failed: ${errorText(err)}`,
        terminal: false,
      });
    }
  }

  private async onClose(frame: Extract<InFrame, { type: "close" }>): Promise<void> {
    const record = this.sessions.get(frame.session);
    if (!record) return;
    this.sessions.delete(frame.session);
    // 未决 permission 按拒绝结算，并补 permission_dismissed 让 Rust 清 UI（agent 自己
    // 也可能再发 interaction_dismissed，Rust 侧按 id 去重即可）。
    for (const [id, pending] of record.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "permission", behavior: "deny", reason: "session-closed" });
      this.emitFrame({ type: "permission_dismissed", session: frame.session, id, resolvedAs: "deny" });
    }
    record.pending.clear();
    try {
      await record.handle.close();
    } catch (err) {
      this.opts.logger.warn("bridge: close failed", { session: frame.session, error: errorText(err) });
    }
  }

  /**
   * interaction 挂起点（spec §2/B2）：permission 转帧挂起；其它 kind 当场 fail-closed，
   * 另附非终止 error 帧让 Rust/UI 可见（不静默吞）。
   */
  private resolveInteraction(session: string, req: InteractionRequest): Promise<InteractionDecision> {
    const record = this.sessions.get(session);
    if (!record) {
      return Promise.resolve({ kind: "permission", behavior: "deny", reason: "session-gone" });
    }
    if (req.kind === "permission") {
      return new Promise<InteractionDecision>((resolve) => {
        const timer = setTimeout(() => {
          record.pending.delete(req.requestId);
          this.emitFrame({
            type: "error",
            session,
            message: `permission ${req.requestId} timed out after ${this.permissionTimeoutMs}ms; denied`,
            terminal: false,
          });
          resolve({ kind: "permission", behavior: "deny", reason: "permission-timeout" });
        }, this.permissionTimeoutMs);
        record.pending.set(req.requestId, { resolve, timer });
        const summary =
          typeof req.displayName === "string" && req.displayName.length > 0
            ? req.displayName
            : typeof req.description === "string" && req.description.length > 0
              ? req.description
              : req.toolName;
        this.emitFrame({ type: "permission", session, id: req.requestId, toolName: req.toolName, summary });
      });
    }
    if (req.kind === "ask_user_question") {
      this.emitFrame({
        type: "error",
        session,
        message: "ask_user_question is not supported in v0; auto-dismissed",
        terminal: false,
      });
      return Promise.resolve({ kind: "ask_user_question", answers: {}, dismissed: true });
    }
    this.emitFrame({
      type: "error",
      session,
      message: "plan_review is not supported in v0; auto-denied",
      terminal: false,
    });
    return Promise.resolve({ kind: "plan_review", behavior: "deny", dismissed: true, reason: "v0-unsupported" });
  }

  /** stdin 关闭（Rust 侧退出）时 abort 全部会话；调用方随后退出进程。 */
  async shutdown(): Promise<void> {
    const records = [...this.sessions.entries()];
    this.sessions.clear();
    for (const [session, record] of records) {
      for (const [, pending] of record.pending) {
        clearTimeout(pending.timer);
        pending.resolve({ kind: "permission", behavior: "deny", reason: "bridge-shutdown" });
      }
      record.pending.clear();
      try {
        await record.handle.abort();
      } catch (err) {
        this.opts.logger.warn("bridge: shutdown abort failed", { session, error: errorText(err) });
      }
    }
    await this.flush();
  }
}
