export type AgentTaskStatus = "needs-input" | "running" | "ready" | "failed" | "limited";
export type AgentTaskGroup = "needs-input" | "running" | "ready" | "failed-limited";
export type AgentTaskFilter = "all" | AgentTaskGroup;

export interface AgentChange {
  path: string;
  additions: number;
  deletions: number;
  kind: "modified" | "added" | "deleted";
}

export interface AgentTimelineEvent {
  at: string;
  event: string;
  tone?: "accent" | "attention" | "success" | "danger";
}

export interface AgentCenterTask {
  id: string;
  taskTitle: string;
  project: string;
  projectPath: string;
  branch: string;
  provider: string;
  model: string;
  status: AgentTaskStatus;
  updated: string;
  summary: string;
  nextStep: string;
  agentNote: string;
  progress?: number;
  failure?: string;
  reset?: string;
  changes: AgentChange[];
  timeline: AgentTimelineEvent[];
}

export const STATUS_LABEL_KEY: Record<AgentTaskStatus, string> = {
  "needs-input": "agentCenter.status.needsInput",
  running: "agentCenter.status.running",
  ready: "agentCenter.status.ready",
  failed: "agentCenter.status.failed",
  limited: "agentCenter.status.limited",
};

export const GROUP_LABEL_KEY: Record<AgentTaskGroup, string> = {
  "needs-input": "agentCenter.status.needsInput",
  running: "agentCenter.status.running",
  ready: "agentCenter.status.ready",
  "failed-limited": "agentCenter.status.failedLimited",
};

export const STATUS_ICON: Record<AgentTaskStatus, string> = {
  "needs-input": "warning",
  running: "run",
  ready: "success",
  failed: "error",
  limited: "clock",
};

export const GROUP_ORDER: AgentTaskGroup[] = ["needs-input", "running", "ready", "failed-limited"];

export function groupOfStatus(status: AgentTaskStatus): AgentTaskGroup {
  return status === "failed" || status === "limited" ? "failed-limited" : status;
}

export function taskMatches(
  task: AgentCenterTask,
  filter: AgentTaskFilter,
  project: string | null,
  query: string,
): boolean {
  if (filter !== "all" && groupOfStatus(task.status) !== filter) return false;
  if (project && task.project !== project) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [task.taskTitle, task.project, task.branch, task.provider, task.model, task.summary].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function fileIcon(path: string): string {
  if (path.endsWith(".test.tsx")) return "file-tsx";
  if (path.endsWith(".tsx")) return "file-tsx";
  if (path.endsWith(".ts")) return "file-ts";
  if (path.endsWith(".css")) return "file-css";
  if (path.endsWith(".rs")) return "file-rust";
  if (path.endsWith(".sql")) return "file-sql";
  if (path.endsWith(".json")) return "file-json";
  if (path.endsWith(".md")) return "file-md";
  if (path.endsWith(".java")) return "file-java";
  if (path.endsWith(".toml")) return "file-toml";
  return "file";
}

export const DEMO_TASKS: readonly AgentCenterTask[] = [
  {
    id: "session-restore",
    taskTitle: "Fix session restore after a window reopen",
    project: "ade-studio",
    projectPath: "D:\\code\\ade-studio",
    branch: "agent/session-restore",
    provider: "Codex",
    model: "GPT-5.4 Codex",
    status: "needs-input",
    updated: "2 min ago",
    summary:
      "The agent traced the lost editor layout to the new window-group persistence path and prepared two migration options.",
    nextStep: "Choose whether to migrate legacy session files or keep a compatibility shim for one release.",
    agentNote:
      "I can keep both paths behind a feature flag, but that adds one more release of cleanup. Do you want the clean migration now?",
    changes: [
      { path: "src/platform/project.ts", additions: 34, deletions: 9, kind: "modified" },
      { path: "src/workbench/projectWindow.ts", additions: 58, deletions: 12, kind: "modified" },
      { path: "src/workbench/Workbench.tsx", additions: 11, deletions: 3, kind: "modified" },
      { path: "src/workbench/Workbench.test.tsx", additions: 42, deletions: 0, kind: "added" },
    ],
    timeline: [
      { at: "18 min ago", event: "Traced the restore failure to the window-group snapshot", tone: "accent" },
      { at: "8 min ago", event: "Added migration code and a regression test" },
      { at: "2 min ago", event: "Paused for a decision on legacy session files", tone: "attention" },
    ],
  },
  {
    id: "audit-invites",
    taskTitle: "Add audit events for namespace invitations",
    project: "skillhub",
    projectPath: "D:\\code\\skillhub",
    branch: "agent/audit-invites",
    provider: "Claude",
    model: "Sonnet 4.6",
    status: "needs-input",
    updated: "7 min ago",
    summary:
      "Invitation create, accept, decline and revoke now have an audit trail, with one policy question left around expiry.",
    nextStep: "Confirm whether revoked invitations should emit both revoked and expired audit rows.",
    agentNote:
      "The current backend deletes expired rows during cleanup. Emitting both events keeps history complete but doubles the audit volume.",
    changes: [
      {
        path: "server/skillhub-domain/src/main/java/com/iflytek/skillhub/domain/namespace/InvitationService.java",
        additions: 46,
        deletions: 7,
        kind: "modified",
      },
      {
        path: "server/skillhub-domain/src/main/java/com/iflytek/skillhub/domain/audit/AuditAction.java",
        additions: 5,
        deletions: 0,
        kind: "modified",
      },
      {
        path: "server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/portal/NamespaceController.java",
        additions: 8,
        deletions: 2,
        kind: "modified",
      },
      {
        path: "server/skillhub-app/src/test/java/com/iflytek/skillhub/namespace/InvitationAuditTest.java",
        additions: 71,
        deletions: 0,
        kind: "added",
      },
    ],
    timeline: [
      { at: "31 min ago", event: "Mapped invitation lifecycle states to audit actions", tone: "accent" },
      { at: "12 min ago", event: "Added controller and domain tests" },
      { at: "7 min ago", event: "Waiting for an expiry-policy decision", tone: "attention" },
    ],
  },
  {
    id: "incremental-diff",
    taskTitle: "Port diff hunks to the incremental renderer",
    project: "ade-studio",
    projectPath: "D:\\code\\ade-studio",
    branch: "agent/incremental-diff",
    provider: "Codex",
    model: "GPT-5.4 Codex",
    status: "running",
    updated: "now",
    progress: 68,
    summary: "Rendering 12k-line diffs without rebuilding every row. The current profile shows 38% fewer long tasks.",
    nextStep: "Running the diff viewer benchmark and Rust IPC tests.",
    agentNote:
      "The renderer boundary is working. I am checking the remaining scroll-anchor regressions before running the full suite.",
    changes: [
      { path: "src/features/vcs/DiffEditor.tsx", additions: 126, deletions: 61, kind: "modified" },
      { path: "src/features/vcs/diffModel.ts", additions: 88, deletions: 17, kind: "modified" },
      { path: "src/features/vcs/DiffEditor.module.css", additions: 14, deletions: 5, kind: "modified" },
      { path: "src/features/vcs/__tests__/diffRenderer.test.tsx", additions: 93, deletions: 12, kind: "modified" },
      { path: "crates/ide-vcs/src/diff.rs", additions: 22, deletions: 4, kind: "modified" },
    ],
    timeline: [
      { at: "34 min ago", event: "Started from the diff viewer hot path", tone: "accent" },
      { at: "16 min ago", event: "First benchmark: 38% fewer long tasks" },
      { at: "now", event: "Running scroll-anchor regression checks", tone: "accent" },
    ],
  },
  {
    id: "acp-host-events",
    taskTitle: "Wire ACP task events into the host registry",
    project: "openidea",
    projectPath: "D:\\code\\openidea",
    branch: "agent/acp-host-events",
    provider: "Claude",
    model: "Opus 4.6",
    status: "running",
    updated: "4 min ago",
    progress: 42,
    summary:
      "Exposing project-scoped ACP tasks through a host-level registry so the center can aggregate every open project.",
    nextStep: "Finish the event fan-out and verify project shutdown cleanup.",
    agentNote:
      "The registry shape is stable. I am now threading the project id through shutdown and re-subscribe paths.",
    changes: [
      { path: "crates/ide-host/src/lib.rs", additions: 54, deletions: 8, kind: "modified" },
      { path: "crates/ide-host/src/project.rs", additions: 31, deletions: 19, kind: "modified" },
      { path: "crates/ide-agent/src/model.rs", additions: 12, deletions: 2, kind: "modified" },
      { path: "src-tauri/src/commands/agent.rs", additions: 18, deletions: 4, kind: "modified" },
    ],
    timeline: [
      { at: "1 hr ago", event: "Defined the host-level registry boundary", tone: "accent" },
      { at: "22 min ago", event: "Project tasks now publish into the registry" },
      { at: "4 min ago", event: "Verifying shutdown and re-subscribe cleanup", tone: "accent" },
    ],
  },
  {
    id: "statusbar-layout",
    taskTitle: "Refactor status bar widget layout",
    project: "ade-studio",
    projectPath: "D:\\code\\ade-studio",
    branch: "agent/statusbar-layout",
    provider: "Codex",
    model: "GPT-5.4 Codex",
    status: "ready",
    updated: "38 min ago",
    summary: "Status widgets now use a single priority-sorted row with stable hit targets in compact mode.",
    nextStep: "Review the compact and toolbar layouts, then run the workbench E2E suite.",
    agentNote: "The layout is ready for review. I kept the old widget API intact so plugins do not need changes.",
    changes: [
      { path: "src/workbench/StatusBar.tsx", additions: 73, deletions: 48, kind: "modified" },
      { path: "src/workbench/StatusBar.module.css", additions: 39, deletions: 22, kind: "modified" },
      { path: "src/workbench/statusBarWidgets.ts", additions: 18, deletions: 7, kind: "modified" },
      { path: "src/workbench/StatusBar.test.tsx", additions: 64, deletions: 21, kind: "modified" },
    ],
    timeline: [
      { at: "2 hr ago", event: "Moved widgets to the priority-sorted row", tone: "accent" },
      { at: "1 hr ago", event: "Fixed compact-mode hit targets" },
      { at: "38 min ago", event: "Marked ready for review", tone: "success" },
    ],
  },
  {
    id: "search-ranking",
    taskTitle: "Replace full-text ranking in the search service",
    project: "skillhub",
    projectPath: "D:\\code\\skillhub",
    branch: "agent/search-ranking",
    provider: "Gemini",
    model: "Gemini 2.5 Pro",
    status: "ready",
    updated: "1 hr ago",
    summary: "Search now uses weighted title, description and namespace fields, with a migration for existing indexes.",
    nextStep: "Review the query plans and migration before merging.",
    agentNote:
      "The ranking change is complete. The migration is reversible and I left the old index in place for one release.",
    changes: [
      {
        path: "server/skillhub-search/src/main/java/com/iflytek/skillhub/search/postgres/QueryService.java",
        additions: 67,
        deletions: 34,
        kind: "modified",
      },
      {
        path: "server/skillhub-search/src/main/java/com/iflytek/skillhub/search/postgres/FullTextIndexService.java",
        additions: 44,
        deletions: 18,
        kind: "modified",
      },
      {
        path: "server/skillhub-app/src/main/resources/db/migration/V1.4.0__search_ranking.sql",
        additions: 26,
        deletions: 0,
        kind: "added",
      },
      {
        path: "server/skillhub-search/src/test/java/com/iflytek/skillhub/search/RankingTest.java",
        additions: 83,
        deletions: 6,
        kind: "modified",
      },
    ],
    timeline: [
      { at: "3 hr ago", event: "Compared ranking strategies on the fixture corpus", tone: "accent" },
      { at: "2 hr ago", event: "Added weighted ranking and migration" },
      { at: "1 hr ago", event: "All search tests passed", tone: "success" },
    ],
  },
  {
    id: "specta-upgrade",
    taskTitle: "Upgrade Tauri IPC code generation",
    project: "openidea",
    projectPath: "D:\\code\\openidea",
    branch: "agent/specta-v3",
    provider: "Codex",
    model: "GPT-5.4 Codex",
    status: "failed",
    updated: "2 hr ago",
    failure:
      "Generated bindings drifted after the upgrade. The Rust test compiled 214 changed binding lines and then failed.",
    summary: "The upgrade reached the binding export step, then stopped on generated type drift.",
    nextStep: "Open the failing build, regenerate bindings, and retry the task.",
    agentNote:
      "The compiler error is reproducible. I need the generated binding diff reviewed before I change the export test.",
    changes: [
      { path: "Cargo.toml", additions: 4, deletions: 4, kind: "modified" },
      { path: "src-tauri/Cargo.toml", additions: 2, deletions: 2, kind: "modified" },
    ],
    timeline: [
      { at: "4 hr ago", event: "Upgraded the code generation dependencies", tone: "accent" },
      { at: "3 hr ago", event: "Regenerated the binding snapshot" },
      { at: "2 hr ago", event: "Stopped on generated binding drift", tone: "danger" },
    ],
  },
  {
    id: "registry-cache",
    taskTitle: "Refresh the agent provider registry cache",
    project: "skillhub",
    projectPath: "D:\\code\\skillhub",
    branch: "agent/registry-cache",
    provider: "Claude",
    model: "Sonnet 4.6",
    status: "limited",
    updated: "3 hr ago",
    reset: "Resets in 42 min",
    summary: "The task is paused after the provider hit its five-hour usage window.",
    nextStep: "Resume when the provider limit resets.",
    agentNote:
      "The cache invalidation change is half complete. I stopped before running the integration test so the next turn can continue cleanly.",
    changes: [
      {
        path: "server/skillhub-app/src/main/java/com/iflytek/skillhub/service/AgentRegistryCache.java",
        additions: 29,
        deletions: 11,
        kind: "modified",
      },
    ],
    timeline: [
      { at: "5 hr ago", event: "Started the cache invalidation change", tone: "accent" },
      { at: "3 hr ago", event: "Paused by the provider usage limit", tone: "attention" },
    ],
  },
];

export const DEMO_PROJECTS: readonly string[] = [...new Set(DEMO_TASKS.map((task) => task.project))];
