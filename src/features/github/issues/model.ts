/**
 * GitHub issues in the Pull Requests tool window: the REST shape of
 * `GET repos/{owner}/{repo}/issues`, mapping to rows, and the branch name
 * "Start Work in Worktree" creates (`issue-<n>-<slug>`).
 */

export type IssueStateFilter = "OPEN" | "CLOSED";

export interface GHIssueLabel {
  name: string;
  color: string | null;
}

export interface GHIssueUser {
  login: string;
  avatarUrl: string | null;
}

/** One row of `GET repos/{owner}/{repo}/issues` (pull requests included, carrying `pull_request`). */
export interface GHIssueRest {
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string | null } | null;
  labels: Array<{ name: string; color: string | null }>;
  assignees: Array<{ login: string; avatar_url: string | null }>;
  comments: number;
  pull_request?: unknown;
}

export interface GHIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: GHIssueUser | null;
  labels: GHIssueLabel[];
  assignees: GHIssueUser[];
  commentCount: number;
}

/** The endpoint lists pull requests too; only rows without `pull_request` are issues. */
export const isIssueRow = (row: GHIssueRest): boolean => row.pull_request == null;

export function toIssue(row: GHIssueRest): GHIssue {
  return {
    number: row.number,
    title: row.title,
    state: row.state === "closed" ? "closed" : "open",
    body: row.body,
    url: row.html_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: row.user ? { login: row.user.login, avatarUrl: row.user.avatar_url } : null,
    labels: row.labels.map((l) => ({ name: l.name, color: l.color })),
    assignees: row.assignees.map((u) => ({ login: u.login, avatarUrl: u.avatar_url })),
    commentCount: row.comments,
  };
}

/** Branch-name slug: lowercase words joined by `-`, unicode letters kept, at most 40 chars. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "issue";
}

/** `issue-12-fix-login-crash`: the branch "Start Work in Worktree" creates. */
export function issueBranchName(issue: Pick<GHIssue, "number" | "title">): string {
  return `issue-${issue.number}-${slugify(issue.title)}`;
}
