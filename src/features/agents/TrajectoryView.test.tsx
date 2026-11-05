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

const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn(async (_text: string) => {}) }));
vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  copyText: copyTextMock,
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
    const overview = screen.getByLabelText("Sequence overview");
    const spans = within(overview).getAllByRole("button");
    expect(spans.length).toBeGreaterThan(0);
    fireEvent.click(spans[0]!);
    expect(document.getElementById("traj-record-1")).toBeTruthy();
    expect(document.getElementById("traj-turn-0")).toBeTruthy();
  });
});

describe("TrajectoryView records", () => {
  it("numbers records by their ledger position", () => {
    renderView();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText("#5")).toBeTruthy();
    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.queryByText("#4")).toBeNull();
  });

  it("copies a record's text", () => {
    renderView();
    const copies = screen.getAllByRole("button", { name: "Copy" });
    expect(copies.length).toBeGreaterThan(0);
    fireEvent.click(copies[0]!);
    expect(copyTextMock).toHaveBeenCalledWith("On it.");
  });

  it("collapses turns individually and all at once", () => {
    renderView();
    const toggles = screen.getAllByRole("button", { name: "Collapse turn" });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]!);
    expect(screen.queryByText("read lexer file")).toBeNull();
    expect(screen.getByText("Turn 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand turn" }));
    expect(screen.getByText("read lexer file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse turns" }));
    expect(screen.queryByText("read lexer file")).toBeNull();
    expect(screen.queryByText("Denied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand turns" }));
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("matches every search term", () => {
    renderView();
    const search = screen.getByPlaceholderText("Search trajectory");
    fireEvent.change(search, { target: { value: "lexer file" } });
    expect(screen.getByText("Turn 1")).toBeTruthy();
    expect(screen.queryByText("Turn 2")).toBeNull();
    fireEvent.change(search, { target: { value: "lexer denied" } });
    expect(screen.getByText("No matching records")).toBeTruthy();
  });

  it("unfolds a collapsed turn when jumping from the overview", () => {
    renderView();
    fireEvent.click(screen.getAllByRole("button", { name: "Collapse turn" })[0]!);
    expect(screen.queryByText("read lexer file")).toBeNull();
    const overview = screen.getByLabelText("Sequence overview");
    fireEvent.click(within(overview).getAllByRole("button")[0]!);
    expect(screen.getByText("read lexer file")).toBeTruthy();
  });
});

describe("TrajectoryView sequence mode", () => {
  it("shows every record in the sequence overview and jumps to records", () => {
    renderView();
    const overview = screen.getByLabelText("Sequence overview");
    const spans = within(overview).getAllByRole("button");
    expect(spans.length).toBeGreaterThan(0);
    fireEvent.click(spans[0]!);
    expect(screen.getByText("On it.")).toBeTruthy();
  });

  it("toggles between sequence and actual timing", () => {
    renderView();
    expect(screen.getByLabelText("Sequence overview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show actual timing" }));
    expect(screen.getByLabelText("Timing overview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show sequence" }));
    expect(screen.getByLabelText("Sequence overview")).toBeTruthy();
  });

  it("renders steered follow-ups and extra turn counts", () => {
    const steered: AgentEntry[] = [
      { type: "user", text: "go", attachments: [], sentMs: 1000, doneMs: null },
      { type: "user", text: "also this", attachments: [], sentMs: 1500, doneMs: null, steered: true },
      {
        type: "subagent",
        id: "c",
        title: null,
        description: null,
        status: "done",
        error: null,
        prompt: null,
        reply: null,
        tools: 0,
        activity: null,
        startedMs: 1100,
        endedMs: 1200,
        cancellable: false,
      },
      { type: "permission", id: 7, title: "Run?", options: [], chosen: null },
    ];
    render(<TrajectoryView task={task()} entries={steered} onOpenSubagent={vi.fn()} />);
    expect(screen.getByText("also this")).toBeTruthy();
    expect(screen.getByText("Steered")).toBeTruthy();
    expect(screen.getByText("1 subagent")).toBeTruthy();
    expect(screen.getByText("1 permission")).toBeTruthy();
  });
});
