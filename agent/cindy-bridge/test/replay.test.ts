import { describe, expect, it } from "vitest";
import type {
  AgentDeps,
  AgentSessionHandle,
  AgentSessionTeardownOptions,
} from "../../../third-party/cindy-agent/maker-core/agents/base-agent.js";
import type {
  AgentEvent,
  InteractionDecision,
  InteractionResolver,
  UsageSnapshot,
} from "../../../third-party/cindy-agent/maker-core/types/events.js";
import type { AgentKind, UserMessage } from "../../../third-party/cindy-agent/maker-core/types/common.js";
import type { SendOptions } from "../../../third-party/cindy-agent/maker-core/agents/base-agent.js";
import { CindyBridge } from "../src/bridge.js";
import { parseInFrame, type OutFrame } from "../src/protocol.js";
import { createStderrLogger } from "../src/stderr-logger.js";

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textEvent(text: string, isFinal = false): AgentEvent {
  return { type: "text", data: { text, isFinal }, source: "claude-code" };
}

/** 可控假句柄：send 时走 resolver（等判决后再续事件），事件按需入队。 */
class FakeHandle {
  readonly id = "sdk-test-1";
  readonly agentKind: AgentKind = "claude-code";
  readonly model = "sonnet";
  sent: UserMessage[] = [];
  decisions: InteractionDecision[] = [];
  aborted = false;
  closed = false;
  autoEvents: AgentEvent[] = [];
  resolver: InteractionResolver | null = null;
  rejectSendWith: Error | null = null;
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];

  enqueue(event: AgentEvent): void {
    this.queue.push(event);
    this.waiters.splice(0).forEach((w) => w());
  }

  setInteractionResolver(resolver: InteractionResolver): void {
    this.resolver = resolver;
  }

  async send(message: UserMessage, _opts?: SendOptions): Promise<void> {
    if (this.rejectSendWith) throw this.rejectSendWith;
    this.sent.push(message);
    if (!this.resolver) {
      for (const e of this.autoEvents) this.enqueue(e);
      return;
    }
    // 模拟真实 agent：工具触发 permission，挂起等判决，判决后才续 turn。
    const decision = await this.resolver({ kind: "permission", requestId: "r-1", toolName: "Bash", input: {} });
    this.decisions.push(decision);
    for (const e of this.autoEvents) this.enqueue(e);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async close(_opts?: AgentSessionTeardownOptions): Promise<void> {
    this.closed = true;
  }

  getUsageSnapshot(): UsageSnapshot {
    return { tokenUsage: 7, contextTokens: 3, contextWindow: 100, costUsd: 0 };
  }

  async *events(): AsyncIterable<AgentEvent> {
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift() as AgentEvent;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

interface Harness {
  bridge: CindyBridge;
  fake: FakeHandle;
  out: OutFrame[];
  send: (line: string) => Promise<void>;
}

function makeHarness(permissionTimeoutMs = 300_000): Harness {
  const fake = new FakeHandle();
  const out: OutFrame[] = [];
  const bridge = new CindyBridge({
    createAgent: () => ({
      startSession: async () => fake as unknown as AgentSessionHandle,
    }),
    deps: {} as unknown as AgentDeps,
    logger: createStderrLogger("test"),
    permissionTimeoutMs,
    emit: (line: string) => {
      const frame = parseInFrame(line);
      // 出帧与入帧类型集不同，这里直接 JSON 解析断言。
      out.push(JSON.parse(line) as OutFrame);
      if (frame) throw new Error("out frame must not parse as in frame");
    },
  });
  return {
    bridge,
    fake,
    out,
    send: (line: string) => bridge.handleLine(line),
  };
}

describe("cindy-bridge NDJSON 回放", () => {
  it("start/prompt/permission(allow)/done 全序列", async () => {
    const h = makeHarness();
    h.fake.autoEvents = [
      textEvent("hel"),
      textEvent("lo "),
      { type: "tool_use", data: { toolUseId: "tu-1", toolName: "Bash" }, source: "claude-code" },
      {
        type: "tool_result",
        data: { summary: "ok", toolUseIds: ["tu-1"] },
        source: "claude-code",
      },
      textEvent("hello", true),
      { type: "done", data: { subtype: "success" }, source: "claude-code" },
    ];

    await h.send(JSON.stringify({ type: "start", session: "s1", cwd: "/tmp/work", model: "sonnet" }));
    await h.bridge.flush();
    expect(h.out).toEqual([{ type: "started", session: "s1", sdkSessionId: "sdk-test-1" }]);

    const prompt = h.send(JSON.stringify({ type: "prompt", session: "s1", text: "hi" }));
    await tick();
    await h.bridge.flush();
    // permission 帧已发出，prompt 仍挂起（等 respond）。
    expect(h.out[1]).toMatchObject({ type: "permission", session: "s1", id: "r-1", toolName: "Bash" });

    await h.send(JSON.stringify({ type: "respond", session: "s1", permissionId: "r-1", decision: "allow" }));
    await prompt;
    await tick();
    await h.bridge.flush();

    expect(h.fake.decisions).toEqual([{ kind: "permission", behavior: "allow" }]);
    expect(h.out.map((f) => f.type)).toEqual(["started", "permission", "text", "text", "tool", "tool", "text", "done"]);
    const done = h.out[h.out.length - 1];
    expect(done).toMatchObject({ type: "done", stopReason: "success" });
    if (done.type === "done") {
      expect(done.usage).toMatchObject({ tokenUsage: 7 });
    }
    // final 全量帧带替换标记。
    expect(h.out[6]).toMatchObject({ type: "text", final: true });
  });

  it("permission 超时按拒绝结算 + 非终止 error 帧", async () => {
    const h = makeHarness(50);
    h.fake.autoEvents = [{ type: "done", data: { subtype: "success" }, source: "claude-code" }];
    await h.send(JSON.stringify({ type: "start", session: "s1", cwd: "/tmp/work", model: "sonnet" }));
    const prompt = h.send(JSON.stringify({ type: "prompt", session: "s1", text: "hi" }));
    await tick();
    await prompt;
    await tick();
    await h.bridge.flush();

    expect(h.fake.decisions).toEqual([{ kind: "permission", behavior: "deny", reason: "permission-timeout" }]);
    const errors = h.out.filter((f) => f.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ terminal: false });
  });

  it("cancel 透传 abort；close 结算未决 permission 并清理", async () => {
    const h = makeHarness();
    await h.send(JSON.stringify({ type: "start", session: "s1", cwd: "/tmp/work", model: "sonnet" }));
    const prompt = h.send(JSON.stringify({ type: "prompt", session: "s1", text: "hi" }));
    await tick();

    await h.send(JSON.stringify({ type: "cancel", session: "s1" }));
    expect(h.fake.aborted).toBe(true);

    await h.send(JSON.stringify({ type: "close", session: "s1" }));
    await prompt;
    await h.bridge.flush();
    expect(h.fake.closed).toBe(true);
    expect(h.fake.decisions).toEqual([{ kind: "permission", behavior: "deny", reason: "session-closed" }]);
    expect(h.out).toContainEqual({ type: "permission_dismissed", session: "s1", id: "r-1", resolvedAs: "deny" });
  });

  it("缺 model 的 start 直接报错（不静默选模型）", async () => {
    const h = makeHarness();
    await h.send(JSON.stringify({ type: "start", session: "s1", cwd: "/tmp/work" }));
    await h.bridge.flush();
    expect(h.out).toEqual([
      { type: "error", session: "s1", message: "model is required in start frame", terminal: true },
    ]);
  });

  it("未知会话 + 非法行：前者回 error 帧，后者忽略", async () => {
    const h = makeHarness();
    await h.send(JSON.stringify({ type: "prompt", session: "nope", text: "hi" }));
    await h.send("not-json{{{");
    await h.send(JSON.stringify({ type: "bogus", session: "s1" }));
    await h.bridge.flush();
    expect(h.out).toEqual([{ type: "error", session: "nope", message: "unknown session: nope" }]);
  });
});
