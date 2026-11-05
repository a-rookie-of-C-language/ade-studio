import { describe, expect, it } from "vitest";
import { isIssueRow, issueBranchName, slugify, toIssue, type GHIssueRest } from "./model";

const row = (over: Partial<GHIssueRest> = {}): GHIssueRest => ({
  number: 12,
  title: "Fix login crash!",
  state: "open",
  body: null,
  html_url: "https://github.com/org/app/issues/12",
  created_at: "2020-01-02T10:00:00Z",
  updated_at: "2020-01-03T10:00:00Z",
  user: { login: "ann", avatar_url: null },
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [{ login: "bob", avatar_url: "https://example.com/b.png" }],
  comments: 3,
  ...over,
});

describe("issues", () => {
  it("keeps only rows without pull_request", () => {
    expect(isIssueRow(row())).toBe(true);
    expect(isIssueRow(row({ pull_request: null }))).toBe(true);
    expect(isIssueRow(row({ pull_request: { url: "https://api.github.com/x" } }))).toBe(false);
  });

  it("maps the REST shape to a row", () => {
    expect(toIssue(row())).toMatchObject({
      number: 12,
      title: "Fix login crash!",
      state: "open",
      url: "https://github.com/org/app/issues/12",
      author: { login: "ann", avatarUrl: null },
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [{ login: "bob", avatarUrl: "https://example.com/b.png" }],
      commentCount: 3,
    });
    expect(toIssue(row({ state: "closed", user: null })).state).toBe("closed");
    expect(toIssue(row({ user: null })).author).toBeNull();
  });

  it("slugs titles for branch names, keeping unicode words", () => {
    expect(slugify("Fix login crash!")).toBe("fix-login-crash");
    expect(slugify("  a__b  c  ")).toBe("a-b-c");
    expect(slugify("修复登录崩溃")).toBe("修复登录崩溃");
    expect(slugify("!!!")).toBe("issue");
    expect(slugify("x".repeat(100))).toHaveLength(40);
  });

  it("names the work branch issue-<n>-<slug>", () => {
    expect(issueBranchName({ number: 12, title: "Fix login crash!" })).toBe("issue-12-fix-login-crash");
    expect(issueBranchName({ number: 7, title: "!!!" })).toBe("issue-7-issue");
  });
});
