/**
 * cindy-bridge v0 私有 NDJSON 线格式（见 docs/cindy-agent-bridge-spec.md §2）。
 *
 * Rust → bridge（stdin，每行一帧）；bridge → Rust（stdout，每行一帧）。
 * stderr 只走日志，绝不混入帧通道。
 */

/** Rust → bridge 的入帧。 */
export type InFrame =
  | { type: "start"; session: string; cwd: string; model?: string }
  | { type: "prompt"; session: string; text: string; messageUuid?: string }
  | {
      type: "respond";
      session: string;
      permissionId: string;
      decision: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
    }
  | { type: "cancel"; session: string }
  | { type: "close"; session: string };

/** bridge → Rust 的出帧。 */
export type OutFrame =
  | { type: "started"; session: string; sdkSessionId: string }
  | {
      type: "text";
      session: string;
      delta: string;
      kind?: "text" | "thinking";
      /** true = 完整文本，Rust 侧替换本 turn 缓冲；缺席/false = 增量，追加。 */
      final?: boolean;
    }
  | {
      type: "tool";
      session: string;
      name: string;
      status: "started" | "completed";
      toolUseId?: string;
    }
  | {
      type: "permission";
      session: string;
      id: string;
      toolName?: string;
      summary?: string;
    }
  | { type: "permission_dismissed"; session: string; id: string; resolvedAs?: string }
  | { type: "done"; session: string; stopReason: string; usage?: Record<string, unknown> }
  | { type: "error"; session: string; message: string; terminal?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const IN_TYPES = new Set(["start", "prompt", "respond", "cancel", "close"]);

/** 解析一行 stdin；非法 JSON 或未知帧类型返回 null（调用方记 stderr 日志并忽略）。 */
export function parseInFrame(line: string): InFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !IN_TYPES.has(parsed.type)) {
    return null;
  }
  if (typeof parsed.session !== "string" || parsed.session.length === 0) {
    return null;
  }
  switch (parsed.type) {
    case "start":
      if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) return null;
      if (parsed.model !== undefined && typeof parsed.model !== "string") return null;
      return { type: "start", session: parsed.session, cwd: parsed.cwd, model: parsed.model };
    case "prompt":
      if (typeof parsed.text !== "string") return null;
      if (parsed.messageUuid !== undefined && typeof parsed.messageUuid !== "string") return null;
      return { type: "prompt", session: parsed.session, text: parsed.text, messageUuid: parsed.messageUuid };
    case "respond":
      if (typeof parsed.permissionId !== "string") return null;
      if (parsed.decision !== "allow" && parsed.decision !== "deny") return null;
      if (parsed.updatedInput !== undefined && !isRecord(parsed.updatedInput)) return null;
      return {
        type: "respond",
        session: parsed.session,
        permissionId: parsed.permissionId,
        decision: parsed.decision,
        updatedInput: parsed.updatedInput,
      };
    case "cancel":
      return { type: "cancel", session: parsed.session };
    case "close":
      return { type: "close", session: parsed.session };
    default:
      return null;
  }
}

/** 出帧序列化（一行 NDJSON，无尾换行，由写方追加）。 */
export function stringifyOutFrame(frame: OutFrame): string {
  return JSON.stringify(frame);
}
