/**
 * The issues tab: REST rows render, endpoint pull requests are left out, the
 * Open/Closed filter reloads, and the context menu offers Start Work in
 * Worktree. Mirrors `list/list.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import * as ipc from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useContextMenuStore, type MenuItem } from "@/ui";
import { setCurrentRepository } from "../api/client";
import type { GHRepository, GHUser } from "../api/types";
import { useGhRepository } from "../data/repository";
import { reloadIssues, resetIssues, setIssuesFilter, useGhIssues } from "./data";
import { IssuesPanel } from "./IssuesPanel";
import type { GHIssueRest } from "./model";

const me: GHUser = { __typename: "User", id: "U1", login: "me", url: "", avatarUrl: "", name: null };

function row(number: number, over: Partial<GHIssueRest> = {}): GHIssueRest {
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
    ...over,
  };
}

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

describe("IssuesPanel", () => {
  let pages: GHIssueRest[][] = [];
  let endpoints: string[] = [];
  beforeEach(() => {
    localStorage.clear();
    useProject.setState({ project: { root: "/p", name: "p" } as never });
    pages = [];
    endpoints = [];
    vi.spyOn(ipc.commands, "ghApi").mockImplementation(async (_repo, req) => {
      endpoints.push(req.endpoint);
      return { status: "ok", data: JSON.stringify(pages.shift() ?? []) } as never;
    });
    setCurrentRepository({ owner: "org", name: "app", id: "R1" });
    useGhRepository.setState({
      availability: { kind: "ready", repo: {} as never, login: "me" },
      remotes: [{ owner: "org", name: "app", remote: "origin", url: "" }],
      connection: { coordinates: { owner: "org", name: "app" }, repository, currentUser: me, root: null, remotes: [] },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetIssues();
    useGhRepository.setState({ connection: null, availability: null, remotes: [] });
    setCurrentRepository(null);
    useContextMenuStore.setState({ menu: null });
  });

  const mount = async () => {
    await act(async () => {
      render(<IssuesPanel />);
    });
  };

  it("loads open issues and leaves out pull requests", async () => {
    pages = [
      [
        row(7, {
          title: "Fix the thing",
          labels: [{ name: "bug", color: "d73a4a" }],
          assignees: [{ login: "bob", avatar_url: null }],
          comments: 3,
        }),
        row(8, { title: "Not an issue", pull_request: { url: "https://api.github.com/x" } }),
      ],
    ];
    await mount();
    expect(endpoints[0]).toBe("repos/org/app/issues?state=open&per_page=50&sort=updated&direction=desc");
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    const first = within(rows[0]!);
    expect(first.getByText("Fix the thing")).toBeTruthy();
    expect(first.getByText("3")).toBeTruthy();
    expect(first.getByText(/^#7 · updated .+, by ann · bug$/)).toBeTruthy();
    expect(screen.queryByText("Not an issue")).toBeNull();
  });

  it("reloads closed issues when the filter changes", async () => {
    pages = [[row(1)], [row(2, { state: "closed" })]];
    await mount();
    expect(screen.getByText("Issue 1")).toBeTruthy();
    await act(async () => {
      setIssuesFilter("CLOSED");
    });
    expect(endpoints[endpoints.length - 1]).toContain("state=closed");
    expect(screen.getByText("Issue 2")).toBeTruthy();
  });

  it("opens the context menu with Start Work in Worktree", async () => {
    pages = [[row(1), row(2)]];
    await mount();
    fireEvent.contextMenu(screen.getAllByRole("option")[1]!);
    expect(useGhIssues.getState().selection).toBe(2);
    const items = useContextMenuStore.getState().menu!.items;
    expect(items.map((i: MenuItem) => ("action" in i ? i.action : i.kind))).toEqual([
      "github.issue.startWorktree",
      "github.issue.openInBrowser",
      "github.issue.copyUrl",
      "separator",
      "github.refreshIssues",
    ]);
  });

  it("shows the empty state and load errors with Retry", async () => {
    pages = [[]];
    await mount();
    expect(screen.getByText("No open issues in app")).toBeTruthy();
    vi.mocked(ipc.commands.ghApi).mockRejectedValueOnce(new Error("HTTP 502"));
    await act(async () => {
      await reloadIssues();
    });
    expect(screen.getByText("Can't load issues")).toBeTruthy();
    pages = [[row(3)]];
    await act(async () => fireEvent.click(screen.getByText("Retry")));
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
});
