/**
 * The cowork sidecar card: with no project open it connects the task's own
 * root and reuses `IssuesPanel`; with a project open it renders nothing (the
 * Pull Requests tool window owns issues there). Its context menu calls the
 * issue helpers directly, since tool-window actions need `projectOpen`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AgentTask } from "@/bindings";
import * as ipc from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { resolveMenuItems, useContextMenuStore } from "@/ui";
import { setCurrentRepository } from "../api/client";
import type { GHRepository } from "../api/types";
import { useGhRepository } from "../data/repository";
import { resetIssues } from "./data";
import { IssuesSidecarCard } from "./IssuesSidecarCard";
import type { GHIssueRest } from "./model";

const repository: GHRepository = {
  id: "R1",
  owner: { __typename: "User", id: "O1", login: "org" },
  nameWithOwner: "org/app",
  viewerPermission: "READ",
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  defaultBranchRef: { name: "main" },
  isFork: false,
  url: "https://github.com/org/app",
  sshUrl: "",
};

function row(number: number): GHIssueRest {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    body: null,
    html_url: `https://github.com/org/app/issues/${number}`,
    created_at: "2020-01-02T10:00:00Z",
    updated_at: "2020-01-03T10:00:00Z",
    user: { login: "ann", avatar_url: null },
    labels: [],
    assignees: [],
    comments: 0,
  };
}

const task = (): AgentTask => ({
  id: "task",
  title: "Task",
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "D:/repo",
  projectRoot: "D:/repo",
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

describe("IssuesSidecarCard", () => {
  beforeEach(() => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    localStorage.clear();
    useProject.setState({ project: null });
    resetIssues();
    useGhRepository.setState({ connection: null, availability: null, remotes: [], defaultRemote: null });
    setCurrentRepository(null);
    useContextMenuStore.setState({ menu: null });
    vi.spyOn(ipc.commands, "vcsRemotes").mockImplementation(
      async () => ({ status: "ok", data: [{ name: "origin", url: "https://github.com/org/app.git" }] }) as never,
    );
    vi.spyOn(ipc.commands, "vcsOpenExternalLog").mockImplementation(
      async () => ({ status: "ok", data: "D:/repo" }) as never,
    );
    vi.spyOn(ipc.commands, "ghAvailability").mockImplementation(
      async () =>
        ({
          status: "ok",
          data: { kind: "ready", repo: { nameWithOwner: "org/app", url: "" }, login: "me" },
        }) as never,
    );
    vi.spyOn(ipc.commands, "ghApi").mockImplementation(async (_repo, req) => {
      if (req.endpoint === "graphql") return { status: "ok", data: JSON.stringify({ data: { repository } }) } as never;
      if (req.endpoint === "user")
        return {
          status: "ok",
          data: JSON.stringify({ node_id: "U1", login: "me", html_url: "", avatar_url: null, name: null }),
        } as never;
      return { status: "ok", data: JSON.stringify([row(1), row(2)]) } as never;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetIssues();
    useGhRepository.setState({ connection: null, availability: null, remotes: [] });
    setCurrentRepository(null);
    useContextMenuStore.setState({ menu: null });
  });

  it("connects the task root and lists its issues in Cowork", async () => {
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText("Issue 1")).toBeTruthy();
    expect(screen.getByText("Issue 2")).toBeTruthy();
    expect(vi.mocked(ipc.commands.vcsRemotes)).toHaveBeenCalledWith("D:/repo");
  });

  it("opens the task root as an external log so its remotes resolve", async () => {
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    expect(vi.mocked(ipc.commands.vcsOpenExternalLog)).toHaveBeenCalledWith("D:/repo");
    expect(vi.mocked(ipc.commands.vcsRemotes)).toHaveBeenCalledWith("D:/repo");
  });

  it("renders nothing when a project is open", async () => {
    useProject.setState({ project: { root: "D:/repo", name: "repo" } as never });
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    expect(screen.queryByText("Issues")).toBeNull();
    expect(vi.mocked(ipc.commands.vcsRemotes)).not.toHaveBeenCalled();
  });

  it("reports the task root itself when it is not a git checkout", async () => {
    vi.mocked(ipc.commands.vcsRemotes).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    expect(screen.getByText("No GitHub repository")).toBeTruthy();
    expect(screen.getByText("D:/repo")).toBeTruthy();
    expect(screen.getByText("D:/repo: boom")).toBeTruthy();
    expect(vi.mocked(ipc.commands.ghAvailability)).not.toHaveBeenCalled();
  });

  it("asks gh in the task root when it has no GitHub remote", async () => {
    vi.mocked(ipc.commands.vcsRemotes).mockResolvedValueOnce({ status: "ok", data: [] } as never);
    vi.mocked(ipc.commands.ghAvailability).mockResolvedValueOnce({
      status: "ok",
      data: { kind: "notGitHub", message: "no remotes found" },
    } as never);
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    expect(vi.mocked(ipc.commands.ghAvailability)).toHaveBeenCalledWith("D:/repo");
    expect(screen.getByText("No GitHub repository")).toBeTruthy();
    expect(screen.getByText("D:/repo")).toBeTruthy();
  });

  it("offers an enabled direct menu (no projectOpen actions)", async () => {
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    fireEvent.contextMenu(screen.getAllByRole("option")[0]!);
    const items = useContextMenuStore.getState().menu!.items;
    const resolved = resolveMenuItems(items);
    expect(resolved.map((i) => (i.kind === "item" ? i.label : i.kind))).toEqual([
      "Start Work in Worktree",
      "View Issue in Browser",
      "Copy Issue URL",
      "separator",
      "Refresh List",
    ]);
    expect(resolved.every((i) => i.kind !== "item" || !i.disabled)).toBe(true);
  });

  it("collapses the issues list", async () => {
    await act(async () => {
      render(<IssuesSidecarCard task={task()} />);
    });
    expect(screen.getByText("Issue 1")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /^Issues/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Issue 1")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Issue 1")).toBeTruthy();
  });
});
