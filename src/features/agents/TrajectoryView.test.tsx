import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentEntry, AgentTask } from "@/bindings";
import { TrajectoryView } from "./TrajectoryView";

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    fsProbe: async () => ({ status: "ok", data: null }),
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput: vi.fn(), openFile: vi.fn() }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

const task = (): AgentTask => ({
  id: "task",
  title: "Task",
  provider: "codex",
  status: "ready",
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
});

const entries = (): AgentEntry[] => [
  { type: "user", text: "fix the lexer", attachments: [], sentMs: 1000, doneMs: 9000 },
  { type: "agent", text: "On it." },
  {
    type: "tool",
    id: "t1",
    title: "read lexer file",
    kind: "read",
    status: "completed",
    locations: [],
    output: "line one\nline two",
    diffs: [],
  },
  { type: "user", text: "also update Cargo docs", attachments: [], sentMs: 10_000, doneMs: null },
  { type: "error", message: "Denied" },
];

function renderView(onOpenSubagent = vi.fn()) {
  return render(<TrajectoryView task={task()} entries={entries()} onOpenSubagent={onOpenSubagent} />);
}

describe("TrajectoryView", () => {
  it("groups entries into turns with counts", () => {
    renderView();
    expect(screen.getByText("Turn 1")).toBeTruthy();
    expect(screen.getByText("Turn 2")).toBeTruthy();
    expect(screen.getByText("fix the lexer")).toBeTruthy();
    expect(screen.getByText("read lexer file")).toBeTruthy();
    expect(screen.getByText("1 tool call")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("opens a subagent when its row is clicked", () => {
    const onOpen = vi.fn();
    const withSubagent: AgentEntry[] = [
      { type: "user", text: "go", attachments: [], sentMs: 1000, doneMs: 2000 },
      {
        type: "subagent",
        id: "child",
        title: "Explore",
        description: null,
        status: "done",
        error: null,
        prompt: null,
        reply: null,
        tools: 3,
        activity: null,
        startedMs: 1100,
        endedMs: 1900,
        cancellable: false,
      },
    ];
    render(<TrajectoryView task={task()} entries={withSubagent} onOpenSubagent={onOpen} />);
    fireEvent.click(screen.getByText("Explore"));
    expect(onOpen).toHaveBeenCalledWith("child");
  });

  it("filters records by the search query", () => {
    renderView();
    const search = screen.getByPlaceholderText("Search trajectory");
    fireEvent.change(search, { target: { value: "lexer" } });
    expect(screen.queryByText("Turn 2")).toBeNull();
    expect(screen.getByText("Turn 1")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing matches this" } });
    expect(screen.getByText("No matching records")).toBeTruthy();
  });

  it("toggles tail following", () => {
    renderView();
    const stop = screen.getByRole("button", { name: "Stop following" });
    fireEvent.click(stop);
    expect(screen.getByRole("button", { name: "Follow new activity" })).toBeTruthy();
  });

  it("jumps from the overview to a turn", () => {
    renderView();
    const overview = screen.getByLabelText("Timing overview");
    const spans = within(overview).getAllByRole("button");
    expect(spans.length).toBeGreaterThan(0);
    fireEvent.click(spans[0]!);
    expect(document.getElementById("traj-turn-0")).toBeTruthy();
  });
});
