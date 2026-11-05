/**
 * Issues of the connected repository (Orca's "GitHub, Native": browse issues
 * without leaving the IDE, start work in an isolated worktree from any task).
 * Loaded through gh's REST passthrough (`api/client.ts`), so no backend change;
 * "Start Work in Worktree" creates `issue-<n>-<slug>` and opens
 * `<repository root>_ISSUE_<n>` in a new window, mirroring `data/local.ts`.
 */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { notifications } from "@/workbench/contributions";
import { errorMessage, repoPath, rest } from "../api/client";
import { withBusy } from "../data/local";
import { connectedRoot } from "../data/repository";
import { isIssueRow, issueBranchName, toIssue, type GHIssue, type GHIssueRest, type IssueStateFilter } from "./model";

interface IssuesState {
  items: GHIssue[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  filter: IssueStateFilter;
  /** The issue actions (`github.issue.*`) and the context menu apply to. */
  selection: number | null;
}

const initial = (): IssuesState => ({
  items: [],
  loading: false,
  error: null,
  loaded: false,
  filter: "OPEN",
  selection: null,
});

export const useGhIssues = create<IssuesState>(initial);

export function setIssuesFilter(filter: IssueStateFilter) {
  useGhIssues.setState({ filter });
  void reloadIssues();
}

export function setIssuesSelection(selection: number | null) {
  useGhIssues.setState({ selection });
}

/** Another repository: the panel reloads on next show. */
export function resetIssues() {
  useGhIssues.setState(initial());
}

export function issueByNumber(number: number): GHIssue | undefined {
  return useGhIssues.getState().items.find((i) => i.number === number);
}

export async function reloadIssues(): Promise<void> {
  const { filter } = useGhIssues.getState();
  useGhIssues.setState({ loading: true, error: null });
  try {
    const rows = await rest<GHIssueRest[]>(
      "GET",
      `${repoPath()}/issues?state=${filter.toLowerCase()}&per_page=50&sort=updated&direction=desc`,
    );
    useGhIssues.setState({ items: rows.filter(isIssueRow).map(toIssue), loading: false, loaded: true });
  } catch (e) {
    useGhIssues.setState({ loading: false, error: errorMessage(e) });
  }
}

/** "View Issue in Browser". */
export async function openIssueInBrowser(number: number): Promise<void> {
  const issue = issueByNumber(number);
  if (issue) await openExternalUrl(issue.url);
}

/** "Copy Issue URL". */
export async function copyIssueUrl(number: number): Promise<void> {
  const issue = issueByNumber(number);
  if (issue) await navigator.clipboard?.writeText(issue.url);
}

/**
 * "Start Work in Worktree": creates `issue-<n>-<slug>` and opens
 * `<repository root>_ISSUE_<n>` on it in a new window.
 */
export async function startIssueWorktree(number: number): Promise<void> {
  const issue = issueByNumber(number);
  if (!issue) return;
  const repo = connectedRoot();
  let base = repo;
  if (!base) {
    const roots = await call(commands.vcsRoots()).catch(() => []);
    const first = roots.length > 0 ? roots[0] : undefined;
    base = first ? String(first.root) : null;
  }
  if (!base) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx`Couldn't create the worktree for #${number}`,
      key: "github-op",
    });
    return;
  }
  const branch = issueBranchName(issue);
  const path = `${base.replace(/[\\/]+$/, "")}_ISSUE_${number}`;
  const op = {
    title: tx`Creating worktree for #${number}…`,
    failure: tx`Couldn't create the worktree for #${number}`,
  };
  const added = await withBusy(op, async () => {
    await call(commands.vcsAddWorktree(repo, path, "HEAD", branch));
    return true;
  });
  if (added) await executeAction("file.openInNewWindow", path);
}
