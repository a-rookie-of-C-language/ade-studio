import { describe, expect, it } from "vitest";
import type { AgentTask } from "@/bindings";
import { groupTasksByProject, projectName } from "./CoworkPage";
import { isPinned, togglePin, useAgents } from "@/features/agents/store";

const task = (patch: Partial<AgentTask> & { id: string }): AgentTask => ({
  title: patch.id,
  status: "running",
  provider: "codex",
  isolation: "local",
  model: null,
  cwd: "/project",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
  ...patch,
});

describe("projectName", () => {
  it("takes the last segment on either separator", () => {
    expect(projectName("/repo/advisor-ai-platform")).toBe("advisor-ai-platform");
    expect(projectName("D:\\code\\openidea")).toBe("openidea");
  });
});

describe("groupTasksByProject", () => {
  it("buckets tasks by projectRoot with groups newest-first", () => {
    const groups = groupTasksByProject([
      task({ id: "old-a", projectRoot: "/repo/a", updatedMs: 1 }),
      task({ id: "new-b", projectRoot: "/repo/b", updatedMs: 3 }),
      task({ id: "new-a", projectRoot: "/repo/a", updatedMs: 2 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["/repo/b", "/repo/a"]);
    expect(groups[1]!.items.map((t) => t.id)).toEqual(["new-a", "old-a"]);
  });

  it("falls back to cwd (e.g. tasks saved before per-task roots)", () => {
    const groups = groupTasksByProject([task({ id: "one", cwd: "D:\\code\\demo" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("D:\\code\\demo");
    expect(projectName(groups[0]!.key)).toBe("demo");
  });

  it("excludes archived tasks", () => {
    const groups = groupTasksByProject([
      task({ id: "gone", projectRoot: "/repo/a", status: "archived", updatedMs: 9 }),
      task({ id: "kept", projectRoot: "/repo/a", updatedMs: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((t) => t.id)).toEqual(["kept"]);
  });
});

describe("togglePin", () => {
  it("pins newest-first and unpins back to empty", () => {
    useAgents.setState({ pinned: [] });
    expect(isPinned("a")).toBe(false);
    togglePin("a");
    togglePin("b");
    expect(useAgents.getState().pinned).toEqual(["b", "a"]);
    expect(isPinned("a")).toBe(true);
    togglePin("a");
    expect(useAgents.getState().pinned).toEqual(["b"]);
    togglePin("b");
    expect(useAgents.getState().pinned).toEqual([]);
    useAgents.setState({ pinned: [] });
  });
});
