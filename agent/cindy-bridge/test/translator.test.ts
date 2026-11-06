import { describe, expect, it } from "vitest";
import type { AgentEvent, UsageSnapshot } from "../../../third-party/cindy-agent/maker-core/types/events.js";
import { translateBridgeEvent } from "../src/translator.js";

function event(type: AgentEvent["type"], data: unknown): AgentEvent {
  return { type, data, source: "claude-code" };
}

const TOOL_NAMES = new Map([["tu-1", "Bash"]]);

describe("translateBridgeEvent", () => {
  it("text 增量直转 text 帧（无 final 标记）", () => {
    expect(translateBridgeEvent("s1", event("text", { text: "hi", isFinal: false }), TOOL_NAMES)).toEqual([
      { type: "text", session: "s1", delta: "hi", kind: "text" },
    ]);
  });

  it("text 全量（isFinal）带 final:true，供 Rust 替换缓冲", () => {
    expect(translateBridgeEvent("s1", event("text", { text: "full", isFinal: true }), TOOL_NAMES)).toEqual([
      { type: "text", session: "s1", delta: "full", kind: "text", final: true },
    ]);
  });

  it("空 text 丢弃", () => {
    expect(translateBridgeEvent("s1", event("text", { text: "" }), TOOL_NAMES)).toEqual([]);
  });

  it("thinking 只有带文本的 delta/final 才转帧", () => {
    expect(translateBridgeEvent("s1", event("thinking", { stage: "start", blockId: "b" }), TOOL_NAMES)).toEqual([]);
    expect(translateBridgeEvent("s1", event("thinking", { stage: "redacted", blockId: "b" }), TOOL_NAMES)).toEqual([]);
    expect(
      translateBridgeEvent("s1", event("thinking", { stage: "delta", blockId: "b", text: "hmm" }), TOOL_NAMES),
    ).toEqual([{ type: "text", session: "s1", delta: "hmm", kind: "thinking" }]);
    expect(
      translateBridgeEvent("s1", event("thinking", { stage: "final", blockId: "b", text: "done-think" }), TOOL_NAMES),
    ).toEqual([{ type: "text", session: "s1", delta: "done-think", kind: "thinking", final: true }]);
  });

  it("tool_use 转 started 帧", () => {
    expect(translateBridgeEvent("s1", event("tool_use", { toolUseId: "tu-1", toolName: "Bash" }), TOOL_NAMES)).toEqual([
      { type: "tool", session: "s1", name: "Bash", status: "started", toolUseId: "tu-1" },
    ]);
  });

  it("tool_result 用 toolUseId 表回填名称", () => {
    expect(
      translateBridgeEvent("s1", event("tool_result", { summary: "ok", toolUseIds: ["tu-1"] }), TOOL_NAMES),
    ).toEqual([{ type: "tool", session: "s1", name: "Bash", status: "completed", toolUseId: "tu-1" }]);
  });

  it("interaction_request 不转帧（resolver 是唯一挂起点）", () => {
    expect(
      translateBridgeEvent(
        "s1",
        event("interaction_request", { kind: "permission", requestId: "r1", toolName: "Bash", input: {} }),
        TOOL_NAMES,
      ),
    ).toEqual([]);
  });

  it("interaction_dismissed 转 permission_dismissed", () => {
    expect(
      translateBridgeEvent("s1", event("interaction_dismissed", { requestId: "r1", resolvedAs: "deny" }), TOOL_NAMES),
    ).toEqual([{ type: "permission_dismissed", session: "s1", id: "r1", resolvedAs: "deny" }]);
  });

  it("done 带 stopReason 与 usage", () => {
    const usage = { tokenUsage: 10, contextTokens: 5, contextWindow: 100, costUsd: 0 } as UsageSnapshot;
    expect(translateBridgeEvent("s1", event("done", { subtype: "success" }), TOOL_NAMES, usage)).toEqual([
      { type: "done", session: "s1", stopReason: "success", usage: { ...usage } },
    ]);
  });

  it("done 无 subtype 回退 stopReason=done", () => {
    expect(translateBridgeEvent("s1", event("done", {}), TOOL_NAMES)).toEqual([
      { type: "done", session: "s1", stopReason: "done" },
    ]);
  });

  it("error 按 isTerminal > !willRetry > true 判定 terminal", () => {
    expect(translateBridgeEvent("s1", event("error", { message: "boom", isTerminal: false }), TOOL_NAMES)).toEqual([
      { type: "error", session: "s1", message: "boom", terminal: false },
    ]);
    expect(translateBridgeEvent("s1", event("error", { message: "retry", willRetry: true }), TOOL_NAMES)).toEqual([
      { type: "error", session: "s1", message: "retry", terminal: false },
    ]);
    expect(translateBridgeEvent("s1", event("error", { message: "x" }), TOOL_NAMES)).toEqual([
      { type: "error", session: "s1", message: "x", terminal: true },
    ]);
  });

  it("status/account_usage/session_id 等系统帧全部丢弃", () => {
    for (const type of ["status", "account_usage", "session_id", "plan_mode_changed", "agent_task_update"] as const) {
      expect(translateBridgeEvent("s1", event(type, {}), TOOL_NAMES)).toEqual([]);
    }
  });

  it("未知 type 前向兼容丢弃", () => {
    expect(translateBridgeEvent("s1", event("some-future-event" as AgentEvent["type"], { a: 1 }), TOOL_NAMES)).toEqual(
      [],
    );
  });
});
