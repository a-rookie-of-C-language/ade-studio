import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import type { AgentChange, AgentEntry, AgentTask } from "@/bindings";
import { AgentsView } from "./AgentsView";
import { SessionEditor } from "./SessionEditor";
import { entriesKey, SESSION_KIND, sessionKey, type SubagentEntry } from "./model";
import { disconnect, useAgents } from "./store";
import { taskActions } from "./taskActions";
import styles from "./Session.module.css";

const backend = vi.hoisted(() => ({
  entries: new Map<string, AgentEntry[]>(),
  changes: [] as AgentChange[],
  answers: [] as Array<[string, number, string | null]>,
  fetched: [] as string[],
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: async (id: string, sub: string | null) => {
      const key = sub ? `${id}/${sub}` : id;
      backend.fetched.push(key);
      return { status: "ok", data: backend.entries.get(key) ?? [] };
    },
    agentChanges: async () => ({ status: "ok", data: backend.changes }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    agentRespond: async (task: string, permission: number, option: string | null) => {
      backend.answers.push([task, permission, option]);
      return { status: "ok", data: null };
    },
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ closeInput: vi.fn(), openInput: vi.fn() }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

const task = (id: string): AgentTask => ({
  id,
  title: id,
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
const subagent: SubagentEntry = {
  type: "subagent",
  id: "child",
  title: "Explore task A",
  description: null,
  status: "done",
  error: null,
  prompt: null,
  reply: null,
  tools: 0,
  activity: null,
  startedMs: 0,
  endedMs: 1,
  cancellable: false,
};
const input = (id: string) => ({ kind: SESSION_KIND, key: sessionKey(id), data: { task: id } });
const stream = () => document.querySelector<HTMLDivElement>(`.${styles.stream}`)!;

const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
afterEach(() => {
  vi.restoreAllMocks();
  if (scrollTopDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

beforeEach(() => {
  disconnect();
  localStorage.clear();
  backend.changes = [];
  backend.entries = new Map([
    ["A", [{ type: "agent", text: "Answer A" }, subagent]],
    [entriesKey("A", "child"), [{ type: "agent", text: "Child answer" }]],
    ["B", [{ type: "agent", text: "Answer B" }]],
  ]);
  useAgents.setState({
    loaded: true,
    sessionLocation: "editor",
    homeOpen: false,
    tasks: new Map([task("A"), task("B")].map((t) => [t.id, t])),
    entries: new Map(backend.entries),
  });
});

describe("a pending question", () => {
  it("shows the whole question in the banner, with every answer, and sends the chosen one", async () => {
    const question =
      'Scenario 4 ("follows the TR") still leaves the "About your request" section empty after two rewrites.\nHow should we continue?';
    const entries: AgentEntry[] = [
      {
        type: "permission",
        id: 7,
        title: question,
        options: [
          { id: "a", name: "Ship it as is and record it (Recommended)", kind: "allow_once" },
          { id: "b", name: "Detect the request in code", kind: "allow_once" },
          { id: "c", name: "Skip", kind: "reject_once" },
        ],
        chosen: null,
      },
    ];
    backend.entries.set("A", entries);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    render(<SessionEditor input={input("A")} />);
    const banner = await screen.findByRole("alert", { name: question });
    expect(banner.querySelector(`.${styles.bannerText}`)?.textContent).toBe(question);
    const answers = within(banner.querySelector<HTMLElement>(`.${styles.bannerActions}`)!).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual([
      "Ship it as is and record it (Recommended)",
      "Detect the request in code",
      "Skip",
    ]);
    fireEvent.click(answers[1]!);
    await waitFor(() => expect(backend.answers).toEqual([["A", 7, "b"]]));
  });
});

describe("a pending permission request in the conversation", () => {
  it("is answered from its line too, and one without options can be cancelled", async () => {
    backend.entries.set("A", [
      {
        type: "permission",
        id: 3,
        title: "ls d:/project",
        options: [
          { id: "once", name: "Allow once", kind: "allow_once" },
          { id: "reject", name: "Reject", kind: "reject_once" },
        ],
        chosen: null,
      },
    ]);
    backend.entries.set("B", [
      { type: "permission", id: 4, title: "The agent asks for permission", options: [], chosen: null },
    ]);
    backend.answers = [];
    useAgents.setState({ entries: new Map(backend.entries) });
    const { unmount } = render(<SessionEditor input={input("A")} />);
    const line = (await screen.findAllByText("ls d:/project")).find((e) =>
      e.classList.contains(styles.permissionTitle!),
    )!.parentElement!;
    const answers = within(line.querySelector<HTMLElement>(`.${styles.permissionAnswers}`)!).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual(["Allow once", "Reject"]);
    fireEvent.click(answers[0]!);
    await waitFor(() => expect(backend.answers).toEqual([["A", 3, "once"]]));
    unmount();

    render(<SessionEditor input={input("B")} />);
    const banner = await screen.findByRole("alert", { name: "The agent asks for permission" });
    fireEvent.click(within(banner).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(backend.answers).toEqual([
        ["A", 3, "once"],
        ["B", 4, null],
      ]),
    );
  });
});

describe("session state across tasks and hosts", () => {
  it("fetches a conversation once and shows it again from the store when its tab reopens", async () => {
    const entries = new Map(useAgents.getState().entries);
    entries.delete("A");
    useAgents.setState({ entries });
    backend.fetched = [];
    const first = render(<SessionEditor input={input("A")} />);
    expect(await screen.findByText("Answer A")).toBeInTheDocument();
    first.unmount();
    render(<SessionEditor input={input("A")} />);
    expect(screen.getByText("Answer A")).toBeInTheDocument();
    await act(async () => {});
    expect(backend.fetched).toEqual(["A"]);
  });

  it("opens a long conversation at its end and renders the earlier entries after it", async () => {
    const entries = Array.from({ length: 150 }, (_, i): AgentEntry => ({ type: "agent", text: `Reply ${i}` }));
    useAgents.setState({ entries: new Map(useAgents.getState().entries).set("A", entries) });
    render(<SessionEditor input={input("A")} />);
    expect(screen.getByText("Reply 149")).toBeInTheDocument();
    expect(await screen.findByText("Reply 0")).toBeInTheDocument();
    expect(stream().children).toHaveLength(150);
  });

  it("returns to the task conversation when the docked task changes after opening a subagent", async () => {
    const dispose = registerActions(taskActions);
    try {
      useAgents.setState({ docked: "A", sessionLocation: "toolWindow" });
      render(<AgentsView />);
      fireEvent.click(screen.getByRole("button", { name: /Explore task A/ }));
      expect(await screen.findByText("Child answer")).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
      fireEvent.click(within(screen.getByRole("tree", { name: "Agent tasks" })).getByText("B"));
      expect(await screen.findByText("Answer B")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
      expect(screen.queryByText("Child answer")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Subagents take their instructions from the agent that started them."),
      ).not.toBeInTheDocument();
      expect(document.querySelector(`.${styles.subagentBar}`)).toBeNull();
    } finally {
      dispose();
    }
  });

  it("keeps docked changes opt-in, preserves the draft, and returns to the same conversation", async () => {
    backend.changes = [
      {
        path: "/project/very-long-file-name.ts",
        relPath: "very-long-file-name.ts",
        kind: "modified",
        added: 8,
        removed: 2,
      },
    ];
    localStorage.setItem("openidea.agents.changesOpen.v1", JSON.stringify({ A: true }));
    useAgents.setState({ docked: "A", sessionLocation: "toolWindow" });
    render(<AgentsView />);
    await screen.findByText("Answer A");
    await waitFor(() => expect(screen.getByRole("button", { name: "Show changes" })).toBeEnabled());
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    const markVisible = vi.spyOn(await import("./store"), "markVisible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "Draft to keep" } });
    const conversation = stream();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByRole("complementary", { name: "Changes" })).toBeVisible();
    expect(screen.getByText("Answer A")).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    act(() => useAgents.setState({ unread: new Set(["A"]) }));
    fireEvent(window, new Event("focus"));
    expect(useAgents.getState().unread.has("A")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(screen.getByText("Answer A")).toBeVisible();
    expect(stream()).toBe(conversation);
    expect(markVisible).toHaveBeenCalledWith("A");
    expect(useAgents.getState().unread.has("A")).toBe(false);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(message);
    expect(message).toHaveValue("Draft to keep");
    expect(useAgents.getState().composers.get("A")?.text).toBe("Draft to keep");
    expect(JSON.parse(localStorage.getItem("openidea.agents.changesOpen.v1")!).A).toBe(true);
  });

  it.each([false, true])("retains scrolling and follow-output (%s) when moving in both directions", async (stick) => {
    // Give jsdom measurable scroll geometry; each host has a different viewport.
    let viewport = 400;
    let height = 2000;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewport);
    const tops = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, top: number) {
        tops.set(this, Math.max(0, Math.min(top, height - viewport)));
      },
    });
    const view = render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    stream().scrollTop = stick ? height - viewport : 230;
    fireEvent.scroll(stream());
    expect(useAgents.getState().scrollPositions.get("A")).toEqual({ top: stick ? 1600 : 230, stick });
    view.unmount();
    viewport = 150;
    useAgents.setState({ docked: "A", sessionLocation: "toolWindow" });
    const dock = render(<AgentsView />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(stick ? height - viewport : 230);
    height = 2400;
    act(() =>
      useAgents.setState({
        entries: new Map(backend.entries).set("A", [
          ...backend.entries.get("A")!,
          { type: "agent", text: "More output" },
        ]),
      }),
    );
    expect(stream().scrollTop).toBe(stick ? height - viewport : 230);
    dock.unmount();
    viewport = 400;
    useAgents.setState({ docked: null });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(stick ? height - viewport : 230);
  });

  it("keeps task and subagent scroll positions separate", async () => {
    useAgents.getState().scrollPositions.set("A", { top: 120, stick: false });
    useAgents.getState().scrollPositions.set("A/child", { top: 70, stick: false });
    useAgents.getState().scrollPositions.set("B", { top: 340, stick: false });
    const view = render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(120);
    fireEvent.click(screen.getByRole("button", { name: /Explore task A/ }));
    await screen.findByText("Child answer");
    expect(stream().scrollTop).toBe(70);
    view.rerender(<SessionEditor input={input("B")} />);
    await screen.findByText("Answer B");
    expect(stream().scrollTop).toBe(340);
    view.rerender(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(stream().scrollTop).toBe(120);
  });

  it("restores after entries load and clears positions on project disconnect", async () => {
    useAgents.getState().scrollPositions.set("A", { top: 230, stick: false });
    useAgents.setState({ entries: new Map() });
    render(<SessionEditor input={input("A")} />);
    await waitFor(() => expect(screen.getByText("Answer A")).toBeInTheDocument());
    expect(stream().scrollTop).toBe(230);
    act(() => disconnect());
    expect(useAgents.getState().scrollPositions.size).toBe(0);
  });
});

describe("meters in the task header", () => {
  afterEach(() => {
    useProject.setState({ settings: null });
    useAgents.setState({ limits: new Map() });
  });

  it("shows the provider's usage limits by default and each meter as Settings › Tools › Agents › Chat allows", async () => {
    const reported: AgentTask = {
      ...task("A"),
      usage: { used: 24_000, size: 200_000, cost: { amount: 0.42, currency: "USD" } },
    };
    const limits = [
      { window: "five_hour", usedPercent: 19, resetsMs: null },
      { window: "seven_day", usedPercent: 9.4, resetsMs: null },
    ];
    useAgents.setState({ tasks: new Map([["A", reported]]), limits: new Map([["codex", limits]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    // Context lives in the sidecar card now, not as a header button.
    expect(screen.queryByRole("button", { name: /Context / })).toBeNull();
    expect(screen.getByText("Used")).toBeInTheDocument();
    expect(screen.getByText("5h 19%")).toBeInTheDocument();
    expect(screen.getByText("7d 9%")).toBeInTheDocument();
    expect(screen.queryByText("$0.42")).toBeNull();
    act(() =>
      useProject.setState({
        settings: { agents: { showContextUsage: false, showUsageLimits: false, showCost: true } },
      }),
    );
    expect(screen.queryByText("Used")).toBeNull();
    expect(screen.queryByText("5h 19%")).toBeNull();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
  });

  it("shows the context breakdown in the sidecar with only the splits the agent reported", async () => {
    const reported: AgentTask = {
      ...task("A"),
      usage: { used: 150_000, size: 200_000, inputTokens: 96_000, outputTokens: 5_000, cacheReadTokens: 27_000 },
      commands: [],
    };
    useAgents.setState({ tasks: new Map([["A", reported]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    // The details render directly in the persistent sidecar card.
    expect(screen.getAllByText("Free space").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Input").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Output").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Cache read").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Cache write")).toBeNull();
    expect(screen.queryByText("Reasoning")).toBeNull();
    expect(screen.queryByText("Compact session")).toBeNull();
  });

  it("offers Compact session when the agent reports a compact command", async () => {
    const reported: AgentTask = {
      ...task("A"),
      usage: { used: 150_000, size: 200_000 },
      commands: [{ name: "compact", description: "Free up context", hint: null }],
    };
    useAgents.setState({ tasks: new Map([["A", reported]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    // The sidecar card offers it; clicking it compacts.
    fireEvent.click(screen.getByRole("button", { name: "Compact session" }));
    expect(useAgents.getState().composers.get("A")?.text).toBe("/compact");
  });

  it("shows Open in IDE in the session header on the Cowork home only", async () => {
    const reported: AgentTask = { ...task("A"), usage: null };
    useAgents.setState({ tasks: new Map([["A", reported]]) });
    useProject.setState({ project: null });
    const { unmount } = render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(screen.getByRole("button", { name: "Open in IDE" })).toBeInTheDocument();
    unmount();
    useProject.setState({ project: { root: "/p", workspace: { projects: ["/p"] } } as never });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(screen.queryByRole("button", { name: "Open in IDE" })).toBeNull();
    // Inside the IDE the title bar's Agent pill returns to Cowork (carrying
    // the session), so the header keeps no second button.
    expect(screen.queryByRole("button", { name: "Back to Cowork" })).toBeNull();
  });

  it("shows the session environment above the context card", async () => {
    const reported: AgentTask = {
      ...task("A"),
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/p/work",
      isolation: "worktree",
      branch: "agent/login-flow",
      usage: { used: 150_000, size: 200_000 },
    };
    useAgents.setState({
      tasks: new Map([["A", reported]]),
      providers: [{ id: "codex", name: "Codex" } as never],
    });
    useProject.setState({ project: { root: "/p", workspace: { projects: ["/p"] } } as never });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    const card = screen.getByText("Environment").closest("section")!;
    expect(card).toBeInTheDocument();
    // Provider display name plus the model the task runs on.
    expect(within(card).getByText("Codex · gpt-5.4")).toBeInTheDocument();
    // Project name plus working directory, and the worktree branch without its prefix.
    expect(within(card).getByText("p · /p/work")).toBeInTheDocument();
    expect(within(card).getByText("login-flow")).toBeInTheDocument();
    // The environment card is the first card in the reserved sidecar.
    expect(card.parentElement!.firstElementChild).toBe(card);
  });

  it("collapses the environment card and hides the branch on local checkouts", async () => {
    const reported: AgentTask = { ...task("A"), usage: null };
    useAgents.setState({ tasks: new Map([["A", reported]]), providers: [] });
    useProject.setState({ project: null });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    const card = screen.getByText("Environment").closest("section")!;
    // Local checkout: agent and directory rows, no branch row.
    expect(within(card).getByText("codex")).toBeInTheDocument();
    expect(within(card).getByText("/project")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Environment" }));
    expect(within(card).queryByText("/project")).toBeNull();
  });

  it("shows cumulative session stats in the sidecar card", async () => {
    const reported: AgentTask = {
      ...task("A"),
      stats: {
        requests: 3800,
        failures: 106,
        retries: 44,
        inputTokens: 13_000_000,
        outputTokens: 1_400_000,
        cacheReadTokens: 336_000_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 1.85,
        activeMs: 9_210_526,
        ttftMs: 16_780_800,
        ttftSamples: 3648,
      },
    };
    useAgents.setState({ tasks: new Map([["A", reported]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    const card = screen.getByRole("region", { name: "Session stats" });
    expect(within(card).getByText("350.4M")).toBeInTheDocument();
    expect(within(card).getByText("3.8k")).toBeInTheDocument();
    expect(within(card).getByText("106 failures")).toBeInTheDocument();
    expect(card.textContent).toContain("Success 97.2%");
    expect(within(card).getByText("44 retried")).toBeInTheDocument();
    expect(within(card).getByText("$1.85")).toBeInTheDocument();
    expect(within(card).getByText("96.3%")).toBeInTheDocument();
    expect(within(card).getByText("152 tokens/s")).toBeInTheDocument();
    expect(within(card).getByText("First-token avg 4.6 seconds · 3,648 samples")).toBeInTheDocument();
  });

  it("hides the session stats card while the session reported nothing", async () => {
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(screen.queryByRole("region", { name: "Session stats" })).toBeNull();
  });

  it("collapses the context card but keeps its usage summary", async () => {
    const reported: AgentTask = { ...task("A"), usage: { used: 150_000, size: 200_000 } };
    useAgents.setState({ tasks: new Map([["A", reported]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    const card = screen.getByRole("region", { name: "Context" });
    expect(within(card).getByText("Free space")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /^Context/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The header summary stays; the detail rows hide.
    expect(within(card).getByText(/used/)).toBeInTheDocument();
    expect(within(card).queryByText("Free space")).toBeNull();
    fireEvent.click(toggle);
    expect(within(card).getByText("Free space")).toBeInTheDocument();
  });

  it("collapses the session stats card", async () => {
    const reported: AgentTask = {
      ...task("A"),
      stats: {
        requests: 10,
        failures: 1,
        retries: 0,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        activeMs: 0,
        ttftMs: 0,
        ttftSamples: 0,
      },
    };
    useAgents.setState({ tasks: new Map([["A", reported]]) });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    const card = screen.getByRole("region", { name: "Session stats" });
    expect(within(card).getByText("Tokens")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Session stats" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(card).queryByText("Tokens")).toBeNull();
    fireEvent.click(toggle);
    expect(within(card).getByText("Tokens")).toBeInTheDocument();
  });
});

describe("message index", () => {
  const convo: AgentEntry[] = [
    { type: "user", text: "First question", attachments: [] },
    { type: "agent", text: "First answer" },
    { type: "user", text: "Second question", attachments: [] },
    { type: "agent", text: "Second answer" },
    { type: "user", text: "Third question", attachments: [] },
  ];

  it("shows one tick per user message and jumps to it", async () => {
    useAgents.setState({ entries: new Map(useAgents.getState().entries).set("A", convo) });
    const scrollIntoView = vi.fn();
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    const prev = proto["scrollIntoView"];
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      render(<SessionEditor input={input("A")} />);
      await screen.findByText("Third question");
      const nav = screen.getByRole("navigation", { name: "Message index" });
      const ticks = within(nav).getAllByRole("button");
      expect(ticks).toHaveLength(3);
      fireEvent.click(ticks[1]!);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(stream().querySelector('[data-entry-index="2"]')?.textContent).toContain("Second question");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(window.HTMLElement.prototype, "scrollIntoView");
      else proto["scrollIntoView"] = prev;
    }
  });

  it("stays hidden with a single user message", async () => {
    useAgents.setState({
      entries: new Map(useAgents.getState().entries).set("A", [convo[0]!, convo[1]!]),
    });
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("First answer");
    expect(screen.queryByRole("navigation", { name: "Message index" })).toBeNull();
  });
});

describe("session header", () => {
  it("offers New Task from the middle session view", async () => {
    render(<SessionEditor input={input("A")} />);
    await screen.findByText("Answer A");
    expect(screen.getByRole("button", { name: "New Task" })).toBeInTheDocument();
  });
});
