/** Carrying one session across the Cowork home ⇄ IDE project switch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentTask } from "@/bindings";
import type { EditorInput, OpenEditorTab } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { backToCowork, connect, consumePendingCarry, disconnect, openCoworkSessionInIDE, useAgents } from "./store";

const backend = vi.hoisted(() => ({
  active: null as EditorInput | null,
  tabs: [] as OpenEditorTab[],
  channel: null as { onmessage: (event: AgentEvent) => void } | null,
  tasks: [] as AgentTask[],
  adopted: null as AgentTask | null,
  adoptError: null as { kind: string; message: string } | null,
  adopt: vi.fn(),
  execAction: vi.fn(),
  notify: vi.fn(),
  openInput: vi.fn(),
  closeInput: vi.fn(),
  showToolWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    agentSubscribe: async (channel: typeof backend.channel) => {
      backend.channel = channel;
      return { status: "ok", data: backend.tasks };
    },
    agentProviders: async () => ({ status: "ok", data: [] }),
    agentExternalSessions: async () => ({ status: "ok", data: [] }),
    agentAdoptTask: async (task: string, sourceRoot: string | null) => {
      backend.adopt(task, sourceRoot);
      if (backend.adoptError) return { status: "error", error: backend.adoptError };
      return { status: "ok", data: backend.adopted ?? taskWithId(task) };
    },
  },
}));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: (...args: unknown[]) => backend.execAction(...args),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    openInput: backend.openInput,
    closeInput: backend.closeInput,
    activeInput: () => backend.active,
    openTabs: () => backend.tabs,
  }),
  toolWindowService: () => ({ show: backend.showToolWindow }),
  notifications: () => ({ notify: backend.notify }),
}));

const taskWithId = (id: string, cwd = "/project"): AgentTask => ({
  id,
  title: id,
  status: "ready",
  provider: "codex",
  isolation: "local",
  model: null,
  cwd,
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

const ideProject = (root: string) => ({
  root,
  name: "project",
  trusted: true,
  isGit: true,
  settings: {} as never,
});

beforeEach(async () => {
  vi.clearAllMocks();
  disconnect();
  // Drop any carry armed by a previous test that never landed.
  useProject.setState({ project: null, lightEdit: false });
  await consumePendingCarry();
  backend.active = null;
  backend.tabs = [];
  backend.adopted = null;
  backend.adoptError = null;
  useAgents.setState({ sessionLocation: "editor" });
  localStorage.clear();
});

describe("cowork session carry", () => {
  it("carries a Cowork session into the IDE project on switch", async () => {
    // On the Cowork home (no project open).
    backend.tasks = [taskWithId("one")];
    await connect();
    expect(useAgents.getState().tasks.has("one")).toBe(true);

    openCoworkSessionInIDE("one");
    expect(backend.execAction).toHaveBeenCalledWith("welcome.openInIDE", "/project");

    // The IDE project loads a different store that never lists the session.
    useProject.setState({ project: ideProject("/project"), lightEdit: false });
    backend.tasks = [];
    backend.adopted = taskWithId("one");
    await connect();

    expect(backend.adopt).toHaveBeenCalledWith("one", null);
    expect(useAgents.getState().tasks.get("one")?.title).toBe("one");
    expect(backend.openInput).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-session", key: "agent:one" }),
      expect.anything(),
    );
  });

  it("matches the target project despite Windows separator differences", async () => {
    backend.tasks = [taskWithId("one", "D:\\work\\proj")];
    await connect();

    openCoworkSessionInIDE("one");
    // The opened project reports forward slashes: still the same switch.
    useProject.setState({ project: ideProject("D:/work/proj"), lightEdit: false });
    backend.tasks = [];
    backend.adopted = taskWithId("one", "D:\\work\\proj");
    await connect();

    expect(backend.adopt).toHaveBeenCalledWith("one", null);
    expect(useAgents.getState().tasks.has("one")).toBe(true);
  });

  it("skips the adopt when the session is already listed", async () => {
    backend.tasks = [taskWithId("one")];
    await connect();
    openCoworkSessionInIDE("one");

    useProject.setState({ project: ideProject("/project"), lightEdit: false });
    backend.tasks = [taskWithId("one")];
    await connect();

    expect(backend.adopt).not.toHaveBeenCalled();
    expect(backend.openInput).toHaveBeenCalled();
  });

  it("drops the carry when the switch lands elsewhere", async () => {
    backend.tasks = [taskWithId("one")];
    await connect();
    openCoworkSessionInIDE("one");

    // The user opened another project (or cancelled): never adopt there.
    useProject.setState({ project: ideProject("/elsewhere"), lightEdit: false });
    backend.tasks = [];
    await connect();
    expect(backend.adopt).not.toHaveBeenCalled();

    // And the dropped carry must not fire on a later matching switch either.
    useProject.setState({ project: ideProject("/project"), lightEdit: false });
    backend.tasks = [];
    await connect();
    expect(backend.adopt).not.toHaveBeenCalled();
  });

  it("carries an IDE session back to the Cowork home", async () => {
    useProject.setState({ project: ideProject("/project"), lightEdit: false });
    backend.tasks = [taskWithId("one")];
    await connect();

    backToCowork("one");
    expect(backend.execAction).toHaveBeenCalledWith("file.closeProject");

    useProject.setState({ project: null, lightEdit: false });
    backend.tasks = [];
    backend.adopted = taskWithId("one");
    await connect();

    expect(backend.adopt).toHaveBeenCalledWith("one", "/project");
    expect(useAgents.getState().coworkTask).toBe("one");
  });

  it("notifies instead of opening when the adopt fails", async () => {
    backend.tasks = [taskWithId("one")];
    await connect();
    openCoworkSessionInIDE("one");

    useProject.setState({ project: ideProject("/project"), lightEdit: false });
    backend.tasks = [];
    backend.adoptError = { kind: "notFound", message: "gone" };
    await connect();

    expect(backend.notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Couldn't import the session" }),
    );
    expect(backend.openInput).not.toHaveBeenCalled();
    expect(useAgents.getState().tasks.has("one")).toBe(false);
  });
});
