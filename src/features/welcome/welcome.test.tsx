import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RecentProject, Settings } from "@/platform/ipc";

const settingsSet = vi.fn();
const removeRecentProject = vi.fn();
const openProject = vi.fn();
const fsReadDir = vi.fn();
const touchRecentProject = vi.fn();
const confirmProjectTrust = vi.fn();
const invokeLocal = vi.fn();
const dialogOpen = vi.fn();
const notify = vi.fn();
const executeAction = vi.fn();
let recent: RecentProject[] = [];

vi.mock("@/platform/actions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/actions")>();
  return { ...real, executeAction: (...args: unknown[]) => executeAction(...args) };
});
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      recentProjects: async () => recent,
      appInfo: async () => ({ version: "1.2.3" }),
      removeRecentProject: (path: string) => removeRecentProject(path),
      fsReadDir: (...args: unknown[]) => fsReadDir(...args),
      touchRecentProject: (path: string) => touchRecentProject(path),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
    },
  };
});
vi.mock("@/platform/project", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/project")>();
  return { ...real, openProject: (path: string) => openProject(path) };
});
vi.mock("@/platform/projectTrust", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/projectTrust")>();
  return { ...real, confirmProjectTrust: (...args: unknown[]) => confirmProjectTrust(...args) };
});
vi.mock("@/platform/tauriCore", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/tauriCore")>();
  return { ...real, invokeLocal: (...args: unknown[]) => invokeLocal(...args) };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => dialogOpen(...args) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...real, notifications: () => ({ notify }) };
});

// The drawer reuses the terminal runtime; stub it so these tests stay free of xterm and PTYs.
const termTabs: Array<{ id: string; name: string; customName: null; session: string; group: string }> = [];
const termNewTab = vi.fn((_cwd: unknown) => {
  const n = termTabs.length;
  const tab = { id: `t${n}`, name: "Local", customName: null, session: `s${n}`, group: "g" };
  termTabs.push(tab);
  return tab;
});
const termSnapshot = () => ({ tabs: termTabs, sessions: {}, selected: {}, activeTab: termTabs[0]?.id ?? null });
vi.mock("@/features/terminal/loader", () => ({
  loadTerminalRuntime: async () => ({
    useTerminals: Object.assign((sel: (s: unknown) => unknown) => sel(termSnapshot()), {
      getState: () => termSnapshot(),
    }),
    startDirectory: (dir: string) => dir,
    newTab: (cwd: unknown) => termNewTab(cwd),
    selectTab: vi.fn(),
    requestCloseTab: vi.fn(),
    tabTitle: (t: { name: string }) => t.name,
    getSession: () => undefined,
    activeSession: () => undefined,
  }),
}));

import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { ContextMenuHost } from "@/ui";
import { MessagesHost } from "@/workbench/messages";
import { projectInitials } from "@/workbench/projectColor";
import { handleListKey } from "./ProjectsPage";
import { filterRecent, useRecent } from "./recent";
import { openCurrentWorkspaceInIDE, openWorkspaceInIDE, useWorkspace } from "./workspace";
import { _resetHomeTerminalForTests, useHomeTerminal } from "./HomeTerminal";
import { useCindy } from "@/features/cindy/store";
import { WelcomeView } from "./WelcomeView";
import { useAgents } from "@/features/agents/store";

const p = (name: string, path: string, branch: string | null = null): RecentProject => ({
  name,
  path,
  branch,
  openedAtMs: null,
});

async function renderWelcome() {
  const view = render(
    <>
      <WelcomeView />
      <ContextMenuHost />
      <MessagesHost />
    </>,
  );
  await act(async () => {});
  return view;
}

async function renderProjects() {
  await renderWelcome();
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  await act(async () => {});
}

const selectedName = () =>
  within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .find((o) => o.getAttribute("aria-selected") === "true")
    ?.querySelector("span span")?.textContent;

const listRows = () => within(screen.getByRole("listbox")).getAllByRole("option");

beforeEach(() => {
  recent = [
    p("acme-api", "/Users/me/repo/acme-api", "dev"),
    p("delta", "/Users/me/repo/delta"),
    p("py-demo", "/tmp/py-demo"),
  ];
  settingsSet.mockReset().mockImplementation(async () => ({ status: "ok", data: { appearance: {} } as Settings }));
  removeRecentProject.mockReset().mockResolvedValue({ status: "ok", data: null });
  openProject.mockReset().mockResolvedValue({});
  fsReadDir.mockReset().mockResolvedValue({ status: "ok", data: [] });
  touchRecentProject.mockReset().mockResolvedValue({ status: "ok", data: null });
  confirmProjectTrust.mockReset().mockResolvedValue(undefined);
  invokeLocal.mockReset().mockResolvedValue({ trusted: true });
  dialogOpen.mockReset().mockResolvedValue(null);
  notify.mockReset();
  executeAction.mockReset();
  termTabs.length = 0;
  termNewTab.mockClear();
  useRecent.setState({ projects: [], loaded: false, home: null, version: null, opening: null });
  useWorkspace.setState({ root: null });
  useProject.setState({ project: null, settings: { appearance: { theme: "light" } } as Settings, opening: false });
  useAgents.setState({ tasks: new Map(), composers: new Map() });
  useCindy.setState({ status: "unknown", lastCheckedMs: null });
  // No embedded Cindy files in tests: the home shows its setup screen deterministically.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("refused");
    }),
  );
  _resetHomeTerminalForTests();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Welcome › Projects", () => {
  it("shows workspace rows with badges, ~ paths and branches", async () => {
    await renderProjects();
    expect(screen.getByText("Default workspace")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    const rows = screen.getAllByRole("option");
    // The pinned default row plus the three recent workspaces.
    expect(rows).toHaveLength(4);
    expect(within(listRows()[0]!).getByText(projectInitials("acme-api"))).toBeTruthy();
    expect(within(listRows()[0]!).getByText("~/repo/acme-api")).toBeTruthy();
    expect(within(listRows()[0]!).getByText("dev")).toBeTruthy();
    expect(within(listRows()[2]!).getByText("/tmp/py-demo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("selects the workspace from a row and returns home without opening the IDE", async () => {
    await renderProjects();
    fireEvent.click(listRows()[0]!);
    await act(async () => {});
    expect(fsReadDir).toHaveBeenCalledWith("/Users/me/repo/acme-api");
    expect(touchRecentProject).toHaveBeenCalledWith("/Users/me/repo/acme-api");
    expect(useWorkspace.getState().root).toBe("/Users/me/repo/acme-api");
    expect(openProject).not.toHaveBeenCalled();
    // Back on the Cindy home.
    expect(await screen.findByText("Cindy is not available")).toBeTruthy();
  });

  it("moves with arrows, filters by typing, selects with Enter and removes with Delete", async () => {
    await renderProjects();
    const search = screen.getByLabelText("Search projects") as HTMLInputElement;
    expect(selectedName()).toBe("acme-api");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(selectedName()).toBe("delta");
    fireEvent.keyDown(search, { key: "Enter" });
    await act(async () => {});
    expect(useWorkspace.getState().root).toBe("/Users/me/repo/delta");
    expect(openProject).not.toHaveBeenCalled();
    expect(await screen.findByText("Cindy is not available")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await act(async () => {});
    const again = screen.getByLabelText("Search projects") as HTMLInputElement;
    fireEvent.keyDown(again, { key: "Delete" });
    const ask = screen.getByRole("dialog", { name: "Remove Recent Project" });
    expect(removeRecentProject).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    await act(async () => {});
    expect(removeRecentProject).toHaveBeenCalledWith("/Users/me/repo/acme-api");

    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "py" } });
    expect(selectedName()).toBe("py-demo");
  });

  it("clears back to the default workspace from the pinned row", async () => {
    await renderProjects();
    fireEvent.click(listRows()[1]!);
    await act(async () => {});
    expect(useWorkspace.getState().root).toBe("/Users/me/repo/delta");

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await act(async () => {});
    fireEvent.click(screen.getByText("Default workspace"));
    await act(async () => {});
    expect(useWorkspace.getState().root).toBeNull();
    expect(await screen.findByText("Cindy is not available")).toBeTruthy();
  });

  it("notifies when the folder is gone instead of selecting it", async () => {
    fsReadDir.mockResolvedValueOnce({ status: "error", error: { kind: "notFound", message: "gone" } });
    await renderProjects();
    fireEvent.click(listRows()[0]!);
    await act(async () => {});
    expect(useWorkspace.getState().root).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
  });

  it("offers Open in New Window in the row menu when the action exists", async () => {
    const dispose = registerActions([{ id: "file.openInNewWindow", title: "Open in New Window", run: () => {} }]);
    await renderProjects();
    fireEvent.click(within(listRows()[0]!).getByRole("button", { name: "Project actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Open in New Window")).toBeTruthy();
    expect(within(menu).getByText("Show in Finder")).toBeTruthy();
    expect(within(menu).getByText("Remove from Recent Projects…")).toBeTruthy();
    dispose();
  });

  it("shows the landing page without recent projects", async () => {
    recent = [];
    await renderProjects();
    expect(screen.getByText("Welcome to OpenIDEA")).toBeTruthy();
    expect(screen.queryByLabelText("Search projects")).toBeNull();
  });

  it("opens a folder from the landing page and selects it", async () => {
    recent = [];
    dialogOpen.mockResolvedValueOnce("/Users/me/repo/fresh");
    await renderProjects();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(fsReadDir).toHaveBeenCalledWith("/Users/me/repo/fresh");
    expect(useWorkspace.getState().root).toBe("/Users/me/repo/fresh");
    expect(await screen.findByText("Cindy is not available")).toBeTruthy();
  });

  it("opens a row in the IDE without touching the home workspace", async () => {
    await renderProjects();
    fireEvent.click(within(listRows()[0]!).getByRole("button", { name: "Open in IDE" }));
    await act(async () => {});
    expect(executeAction).toHaveBeenCalledWith("welcome.openInIDE", "/Users/me/repo/acme-api");
    expect(useWorkspace.getState().root).toBeNull();
  });
});

describe("Welcome › IDE switch", () => {
  it("opens the workspace as an IDE project without revealing the panel here", async () => {
    const ok = await openWorkspaceInIDE("/Users/me/repo/acme-api", "acme-api");
    expect(ok).toBe(true);
    expect(openProject).toHaveBeenCalledWith("/Users/me/repo/acme-api");
    expect(executeAction).not.toHaveBeenCalledWith("agents.showToolWindow");
  });

  it("reveals the agent panel when the project opened in this window", async () => {
    useProject.setState({ project: { root: "/Users/me/repo/acme-api", name: "acme-api" } } as never);
    const ok = await openWorkspaceInIDE("/Users/me/repo/acme-api");
    expect(ok).toBe(true);
    expect(executeAction).toHaveBeenCalledWith("agents.showToolWindow");
  });

  it("opens the picked workspace from the current-workspace switch", async () => {
    useWorkspace.setState({ root: "/Users/me/repo/delta" });
    const ok = await openCurrentWorkspaceInIDE();
    expect(ok).toBe(true);
    expect(openProject).toHaveBeenCalledWith("/Users/me/repo/delta");
  });

  it("falls back to the default workspace when none is picked", async () => {
    const ok = await openCurrentWorkspaceInIDE();
    expect(ok).toBe(true);
    expect(openProject).toHaveBeenCalledWith("/Users/me/.openidea/workspace");
  });
});

describe("Welcome › Cowork", () => {
  it("is the Cindy home: setup screen, no composer", async () => {
    await renderWelcome();
    expect(await screen.findByText("Cindy is not available")).toBeTruthy();
    expect(screen.queryByText("Where should we start?")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "IDE" })).toBeTruthy();
  });

  it("jumps to the IDE for the current workspace from the Cowork home", async () => {
    await renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    await act(async () => {});
    expect(openProject).toHaveBeenCalledWith("/Users/me/.openidea/workspace");
  });

  it("returns home from Projects with the back button", async () => {
    await renderProjects();
    expect(screen.getByLabelText("Search projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => {});
    expect(await screen.findByText("Cindy is not available")).toBeTruthy();
    expect(useWorkspace.getState().root).toBeNull();
  });

  it("opens a terminal drawer rooted at the workspace from the terminal action", async () => {
    await renderWelcome();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    act(() => {
      useHomeTerminal.getState().setOpen(true);
    });
    await screen.findByLabelText("Terminal sessions");
    // The tab lands after the async cwd resolve, so wait for it instead of
    // asserting right after the drawer appears.
    await waitFor(() => expect(termNewTab).toHaveBeenCalledWith("/Users/me/.openidea/workspace"));
    expect(screen.getByRole("button", { name: "New Tab" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Terminal sessions")).toBeNull();
  });

  it("roots new terminal tabs at the picked workspace", async () => {
    useWorkspace.setState({ root: "/Users/me/repo/acme-api" });
    await renderWelcome();
    act(() => {
      useHomeTerminal.getState().setOpen(true);
    });
    await screen.findByLabelText("Terminal sessions");
    await waitFor(() => expect(termNewTab).toHaveBeenCalledWith("/Users/me/repo/acme-api"));
    // The cwd uses the shared tooltip channel (`data-tooltip`), not a native `title`.
    // It lands a tick after the panel mounts (async cwd resolve), so wait for it.
    const cwd = await within(screen.getByRole("complementary", { name: "Terminal" })).findByText("acme-api");
    expect(cwd.getAttribute("data-tooltip")).toBe("/Users/me/repo/acme-api");
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    expect(termNewTab).toHaveBeenCalledTimes(2);
  });

  it("opens the picked workspace in the IDE from the home", async () => {
    useWorkspace.setState({ root: "/Users/me/repo/acme-api" });
    await renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    await act(async () => {});
    expect(openProject).toHaveBeenCalledWith("/Users/me/repo/acme-api");
  });
});

describe("helpers", () => {
  it("maps list keys", () => {
    const items = filterRecent([p("a", "/a"), p("b", "/b")], "");
    expect(
      handleListKey({ key: "ArrowDown", metaKey: false, shiftKey: false }, { items, current: 0, caretAtEnd: true }),
    ).toEqual({
      kind: "move",
      index: 1,
    });
    expect(
      handleListKey({ key: "Delete", metaKey: false, shiftKey: false }, { items, current: 1, caretAtEnd: false }),
    ).toBeNull();
    expect(
      handleListKey({ key: "Delete", metaKey: false, shiftKey: false }, { items, current: 1, caretAtEnd: true }),
    ).toMatchObject({
      kind: "remove",
      match: { project: { path: "/b" } },
    });
    expect(
      handleListKey({ key: "Enter", metaKey: false, shiftKey: false }, { items: [], current: 0, caretAtEnd: true }),
    ).toBeNull();
  });
});
