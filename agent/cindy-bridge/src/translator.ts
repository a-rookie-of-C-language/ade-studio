import type { AgentEvent, UsageSnapshot } from "../../../third-party/cindy-agent/maker-core/types/events.js";
import type { OutFrame } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eventData(event: AgentEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

/**
 * `AgentEvent → v0 出帧`纯翻译（spec §2）。
 *
 * - 同一段文本 vendor 会先给增量、结尾再给一次全量：`data.isFinal === true`（text）
 *   或 `stage === 'final'`（thinking）时置 `final: true`，Rust 侧替换缓冲；
 *   无文本的 thinking 阶段（`start`/`redacted`）直接丢弃。
 * - `tool_result` 摘要帧不带工具名，靠 `toolNames`（`toolUseId → toolName`，bridge 会话侧
 *   从 `tool_use` 事件回填）回填；`tool_result_full` 同理。
 * - `interaction_request` 故意不翻译：唯一的挂起点是 `setInteractionResolver`
 *   回调（bridge.ts），翻事件会造成 Rust 侧双发。
 * - `status` / `account_usage` / `turn_diff` / `compact_boundary` / `session_id` /
 *   `plan_mode_changed` / `image` / `agent_task_update` v0 不转帧（timeline 最小集之外，
 *   后续按需扩展）。
 * - 未知 `type` 返回空数组，保证 vendor 加事件不炸 bridge（前向兼容）。
 */
export function translateBridgeEvent(
  session: string,
  event: AgentEvent,
  toolNames: ReadonlyMap<string, string>,
  usage?: UsageSnapshot,
): OutFrame[] {
  const data = eventData(event);
  switch (event.type) {
    case "text": {
      if (typeof data.text !== "string" || data.text.length === 0) return [];
      const frame: OutFrame = { type: "text", session, delta: data.text, kind: "text" };
      if (data.isFinal === true) frame.final = true;
      return [frame];
    }
    case "thinking": {
      if (typeof data.text !== "string" || data.text.length === 0) return [];
      const frame: OutFrame = { type: "text", session, delta: data.text, kind: "thinking" };
      if (data.stage === "final") frame.final = true;
      return [frame];
    }
    case "tool_use": {
      const toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : undefined;
      const name = typeof data.toolName === "string" && data.toolName.length > 0 ? data.toolName : "tool";
      const frame: OutFrame = { type: "tool", session, name, status: "started" };
      if (toolUseId !== undefined) frame.toolUseId = toolUseId;
      return [frame];
    }
    case "tool_result":
    case "tool_result_full": {
      const ids: string[] = [];
      if (typeof data.toolUseId === "string") ids.push(data.toolUseId);
      if (Array.isArray(data.toolUseIds)) {
        for (const id of data.toolUseIds) {
          if (typeof id === "string" && !ids.includes(id)) ids.push(id);
        }
      }
      if (ids.length === 0) {
        return [{ type: "tool", session, name: "tool", status: "completed" }];
      }
      return ids.map((toolUseId) => {
        const frame: OutFrame = {
          type: "tool",
          session,
          name: toolNames.get(toolUseId) ?? "tool",
          status: "completed",
          toolUseId,
        };
        return frame;
      });
    }
    case "interaction_dismissed": {
      if (typeof data.requestId !== "string") return [];
      const frame: OutFrame = { type: "permission_dismissed", session, id: data.requestId };
      if (typeof data.resolvedAs === "string") frame.resolvedAs = data.resolvedAs;
      return [frame];
    }
    case "done": {
      const stopReason = typeof data.subtype === "string" && data.subtype.length > 0 ? data.subtype : "done";
      const frame: OutFrame = { type: "done", session, stopReason };
      if (usage !== undefined) frame.usage = { ...(usage as unknown as Record<string, unknown>) };
      return [frame];
    }
    case "error": {
      const message = typeof data.message === "string" && data.message.length > 0 ? data.message : "unknown error";
      // 与 vendor `isTerminalAgentErrorEvent` 同优先级：isTerminal > !willRetry > true。
      let terminal = true;
      if (typeof data.isTerminal === "boolean") terminal = data.isTerminal;
      else if (typeof data.willRetry === "boolean") terminal = !data.willRetry;
      return [{ type: "error", session, message, terminal }];
    }
    default:
      return [];
  }
}
