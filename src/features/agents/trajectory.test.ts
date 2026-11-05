import { describe, expect, it } from "vitest";
import type { AgentEntry } from "@/bindings";
import {
  buildTrajectory,
  buildTrajectorySpans,
  buildSequenceSpans,
  matchTrajectoryEntry,
  trajectoryCopyText,
  trajectoryDomain,
  trajectoryEntryText,
  trajectoryIsError,
  trajectorySpanLabel,
  trajectoryQueryTerms,
  turnOfIndex,
} from "./trajectory";

const user = (text: string, sentMs: number | null = null, doneMs: number | null = null): AgentEntry => ({
  type: "user",
  text,
  attachments: [],
  sentMs,
  doneMs,
});
const tool = (title: string): AgentEntry => ({
  type: "tool",
  id: title,
  title,
  kind: "read",
  status: "completed",
  locations: [],
  output: null,
  diffs: [],
});

describe("buildTrajectory", () => {
  it("is empty without entries", () => {
    expect(buildTrajectory([])).toEqual({ turns: [], prefaceEnd: 0 });
  });

  it("groups entries into turns with counts and durations", () => {
    const entries: AgentEntry[] = [
      user("first", 1000, 5000),
      { type: "agent", text: "working" },
      tool("read a"),
      { type: "error", message: "boom" },
      user("second", 9000, null),
      tool("run b"),
    ];
    const { turns, prefaceEnd } = buildTrajectory(entries);
    expect(prefaceEnd).toBe(0);
    expect(turns.map((t) => [t.turn, t.startIndex, t.endIndex])).toEqual([
      [0, 0, 4],
      [1, 4, 6],
    ]);
    expect(turns[0]!.durationMs).toBe(4000);
    expect(turns[0]!.counts).toEqual({ tools: 1, subagents: 0, errors: 1, permissions: 0 });
    expect(turns[1]!.durationMs).toBeNull();
    expect(turns[1]!.counts.tools).toBe(1);
  });

  it("leaves steered messages and leading records outside new turns", () => {
    const entries: AgentEntry[] = [
      { type: "agent", text: "leftover" },
      user("starts", 1000, 2000),
      { type: "user", text: "steered", attachments: [], sentMs: 1500, doneMs: null, steered: true },
      tool("read a"),
    ];
    const { turns, prefaceEnd } = buildTrajectory(entries);
    expect(prefaceEnd).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endIndex).toBe(4);
  });
});

describe("turnOfIndex", () => {
  it("finds the owning turn", () => {
    const { turns } = buildTrajectory([user("a"), tool("x"), user("b")]);
    expect(turnOfIndex(turns, 0)).toBe(0);
    expect(turnOfIndex(turns, 1)).toBe(0);
    expect(turnOfIndex(turns, 2)).toBe(1);
    expect(turnOfIndex([], 0)).toBeNull();
  });
});

describe("spans and domain", () => {
  it("spans turns and subagents, with open ends", () => {
    const entries: AgentEntry[] = [
      user("a", 1000, 3000),
      {
        type: "subagent",
        id: "child",
        title: "Explore",
        description: null,
        status: "running",
        error: null,
        prompt: "look",
        reply: null,
        tools: 2,
        activity: "reading",
        startedMs: 2000,
        endedMs: null,
        cancellable: true,
      },
      user("b", 4000, null),
    ];
    const { turns } = buildTrajectory(entries);
    const spans = buildTrajectorySpans(entries, turns);
    expect(spans.map((s) => s.key)).toEqual(["turn-0", "subagent-child", "turn-1"]);
    expect(spans[1]!.turn).toBe(0);
    expect(spans[1]!.endMs).toBeNull();
    expect(trajectoryDomain(spans, 5000)).toEqual({ start: 1000, end: 5000 });
  });

  it("has no domain without timed records", () => {
    expect(trajectoryDomain([], Date.now())).toBeNull();
    const { turns } = buildTrajectory([user("a"), tool("x")]);
    expect(trajectoryDomain(buildTrajectorySpans([user("a"), tool("x")], turns), 9999)).toBeNull();
  });
});

describe("search", () => {
  it("matches titles, outputs and reports", () => {
    expect(trajectoryEntryText(tool("read Cargo.toml"))).toContain("Cargo.toml");
    expect(matchTrajectoryEntry(tool("read Cargo.toml"), "cargo")).toBe(true);
    expect(matchTrajectoryEntry({ type: "error", message: "Denied" }, "denied")).toBe(true);
    expect(
      matchTrajectoryEntry(
        {
          type: "subagent",
          id: "c",
          title: null,
          description: null,
          status: "done",
          error: null,
          prompt: null,
          reply: "found the bug",
          tools: 0,
          activity: null,
          startedMs: null,
          endedMs: null,
          cancellable: false,
        },
        "BUG",
      ),
    ).toBe(true);
    expect(matchTrajectoryEntry(tool("read a"), "zzz")).toBe(false);
    expect(matchTrajectoryEntry(tool("read a"), "  ")).toBe(true);
  });
});

describe("multi-term search", () => {
  it("requires every query term", () => {
    const entry = tool("read Cargo.toml");
    expect(matchTrajectoryEntry(entry, "read cargo")).toBe(true);
    expect(matchTrajectoryEntry(entry, "read  toml")).toBe(true);
    expect(matchTrajectoryEntry(entry, "TOML READ")).toBe(true);
    expect(matchTrajectoryEntry(entry, "read missing")).toBe(false);
  });

  it("splits queries into terms", () => {
    expect(trajectoryQueryTerms("  read  Cargo ")).toEqual(["read", "cargo"]);
    expect(trajectoryQueryTerms("   ")).toEqual([]);
  });
});

describe("trajectoryCopyText", () => {
  const subagent = (prompt: string | null, reply: string | null): AgentEntry => ({
    type: "subagent",
    id: "c",
    title: null,
    description: null,
    status: "done",
    error: null,
    prompt,
    reply,
    tools: 0,
    activity: null,
    startedMs: null,
    endedMs: null,
    cancellable: false,
  });

  it("copies text records", () => {
    expect(trajectoryCopyText({ type: "agent", text: "hello" })).toBe("hello");
    expect(trajectoryCopyText({ type: "agent", text: "" })).toBeNull();
    expect(trajectoryCopyText({ type: "error", message: "Denied" })).toBe("Denied");
    expect(trajectoryCopyText({ type: "user", text: "go", attachments: [], sentMs: null, doneMs: null })).toBe("go");
  });

  it("copies tool output with its title", () => {
    expect(trajectoryCopyText(tool("read a"))).toContain("read a");
  });

  it("copies permission titles and plan items", () => {
    expect(trajectoryCopyText({ type: "permission", id: 1, title: "Run?", options: [], chosen: null })).toBe("Run?");
    expect(trajectoryCopyText({ type: "plan", items: [{ content: "x", status: "pending" }] })).toBe("x");
    expect(trajectoryCopyText({ type: "plan", items: [] })).toBeNull();
  });

  it("copies subagent prompt and reply", () => {
    expect(trajectoryCopyText(subagent("look", "found"))).toBe("look\n\nfound");
    expect(trajectoryCopyText(subagent(null, null))).toBeNull();
  });
});

describe("sequence spans", () => {
  it("gives every record an equal-width span, skipping turn headers", () => {
    const entries: AgentEntry[] = [
      user("first", 1000, 2000),
      { type: "agent", text: "working" },
      tool("read a"),
      user("second", 3000, null),
      { type: "error", message: "boom" },
    ];
    const { turns } = buildTrajectory(entries);
    const spans = buildSequenceSpans(entries, turns);
    expect(spans.map((s) => s.index)).toEqual([1, 2, 4]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(spans.map((s) => s.turn)).toEqual([0, 0, 1]);
    expect(spans[1]!.lane).toBe(2);
    expect(spans[2]!.isError).toBe(true);
  });

  it("keeps steered follow-ups as records", () => {
    const entries: AgentEntry[] = [
      user("go", 1000, null),
      { type: "user", text: "actually also this", attachments: [], sentMs: null, doneMs: null, steered: true },
    ];
    const { turns } = buildTrajectory(entries);
    expect(turns).toHaveLength(1);
    const spans = buildSequenceSpans(entries, turns);
    expect(spans.map((s) => s.index)).toEqual([1]);
    expect(spans[0]!.turn).toBe(0);
  });

  it("labels spans and flags failures", () => {
    expect(trajectorySpanLabel(tool("read Cargo.toml"))).toContain("Cargo.toml");
    expect(trajectoryIsError({ type: "error", message: "x" })).toBe(true);
    expect(trajectoryIsError(tool("ok"))).toBe(false);
    const failed: AgentEntry = {
      type: "tool",
      id: "bad",
      title: "bad",
      kind: "read",
      status: "failed",
      locations: [],
      output: null,
      diffs: [],
    };
    expect(trajectoryIsError(failed)).toBe(true);
  });

  it("searches tool paths and diffs", () => {
    const entry: AgentEntry = {
      type: "tool",
      id: "run tests",
      title: "run tests",
      kind: "execute",
      status: "completed",
      locations: ["/repo/src/lexer.ts"],
      output: null,
      diffs: [{ path: "src/lexer.ts", added: 3, removed: 1 }],
    };
    expect(matchTrajectoryEntry(entry, "lexer")).toBe(true);
    expect(matchTrajectoryEntry(entry, "lexer missing")).toBe(false);
  });
});
