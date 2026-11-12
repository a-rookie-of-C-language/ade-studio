import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import clsx from "clsx";
import { useT, useTx } from "@/platform/i18n";
import { Button, Icon, IconButton, T, type IconName } from "@/ui";
import { trapTab } from "@/ui/popupState";
import {
  DEMO_PROJECTS,
  DEMO_TASKS,
  GROUP_LABEL_KEY,
  GROUP_ORDER,
  STATUS_ICON,
  STATUS_LABEL_KEY,
  fileIcon,
  groupOfStatus,
  taskMatches,
  type AgentCenterTask,
  type AgentTaskFilter,
  type AgentTaskStatus,
} from "./model";
import { closeAgentCenter, useAgentCenter } from "./store";
import styles from "./AgentCenter.module.css";

type DemoNotice = "newTask" | "reviewDiff" | "openWorktree" | "runTests" | "retry" | "approve" | "sent";

const NOTICE_KEY: Record<DemoNotice, string> = {
  newTask: "agentCenter.notice.newTask",
  reviewDiff: "agentCenter.notice.reviewDiff",
  openWorktree: "agentCenter.notice.openWorktree",
  runTests: "agentCenter.notice.runTests",
  retry: "agentCenter.notice.retry",
  approve: "agentCenter.notice.approve",
  sent: "agentCenter.notice.sent",
};

const FILTERS: Array<{ id: AgentTaskFilter; icon: IconName }> = [
  { id: "all", icon: "list" },
  { id: "needs-input", icon: "warning" },
  { id: "running", icon: "run" },
  { id: "ready", icon: "success" },
  { id: "failed-limited", icon: "error" },
];

function toneOfFilter(filter: AgentTaskFilter): string {
  return filter === "all" ? "accent" : filter === "failed-limited" ? "danger" : filter;
}

function countTasks(predicate: (task: AgentCenterTask) => boolean): number {
  return DEMO_TASKS.filter(predicate).length;
}

export function AgentCenterOverlay() {
  const open = useAgentCenter((state) => state.open);
  return open ? <AgentCenterPanel onClose={closeAgentCenter} /> : null;
}

function AgentCenterPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tx = useTx();
  const rootRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<AgentTaskFilter>("all");
  const [project, setProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(DEMO_TASKS[0]?.id ?? "");
  const [reply, setReply] = useState("");
  const [replies, setReplies] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<DemoNotice | null>(null);

  const filtered = useMemo(
    () => DEMO_TASKS.filter((task) => taskMatches(task, filter, project, query)),
    [filter, project, query],
  );
  const activeTask = filtered.find((task) => task.id === selectedId) ?? filtered[0] ?? null;
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    tasks: filtered.filter((task) => groupOfStatus(task.status) === group),
  })).filter((group) => group.tasks.length > 0);

  const needsInput = countTasks((task) => task.status === "needs-input");
  const running = countTasks((task) => task.status === "running");
  const ready = countTasks((task) => task.status === "ready");

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>("[data-agent-center-initial]")?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab" && rootRef.current) {
        trapTab(event, rootRef.current);
        return;
      }
      const target = event.target;
      const editing =
        target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
      if (event.key === "/" && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  const clearFilters = () => {
    setFilter("all");
    setProject(null);
    setQuery("");
  };

  const selectTask = (id: string) => {
    setSelectedId(id);
    setReply("");
    setNotice(null);
  };

  const sendReply = () => {
    const text = reply.trim();
    if (!activeTask || !text) return;
    setReplies((current) => ({
      ...current,
      [activeTask.id]: [...(current[activeTask.id] ?? []), text],
    }));
    setReply("");
    setNotice("sent");
  };

  const showNotice = (next: DemoNotice) => setNotice(next);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={tx("Agent Center")}>
      <div ref={rootRef} className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>
              <Icon name="toolwindow-pull-requests" size={21} />
            </span>
            <div className={styles.brandCopy}>
              <div className={styles.brandTitle}>
                <h1>
                  <T>Agent Center</T>
                </h1>
                <span className={styles.demoBadge}>
                  <span className={styles.demoDot} />
                  <T>Demo data</T>
                </span>
              </div>
              <p>
                <T>One inbox for agent work across every project</T>
              </p>
            </div>
          </div>

          <div className={styles.topbarRule} />

          <div className={styles.headerOverview} aria-label={tx("Inbox")}>
            <StatusMeter status="needs-input" count={needsInput} />
            <StatusMeter status="running" count={running} />
            <StatusMeter status="ready" count={ready} />
          </div>

          <div className={styles.headerActions}>
            <Button
              icon="plus"
              variant="primary"
              className={styles.newTaskButton}
              onClick={() => showNotice("newTask")}
            >
              <T>New task</T>
            </Button>
            <IconButton
              data-agent-center-initial
              icon="close"
              title="Close Agent Center"
              onClick={onClose}
              iconSize={18}
              size="large"
              className={styles.closeButton}
            />
          </div>
        </header>

        <aside className={styles.rail}>
          <div className={styles.railGlow} aria-hidden="true" />
          <div className={styles.railSection}>
            <div className={styles.sectionLabel}>
              <T>Inbox</T>
            </div>
            <div className={styles.filterList}>
              {FILTERS.map((item) => {
                const count =
                  item.id === "all"
                    ? DEMO_TASKS.length
                    : item.id === "failed-limited"
                      ? countTasks((task) => task.status === "failed" || task.status === "limited")
                      : countTasks((task) => groupOfStatus(task.status) === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.filterButton}
                    data-active={filter === item.id}
                    aria-pressed={filter === item.id}
                    onClick={() => setFilter(item.id)}
                  >
                    <span className={styles.filterIcon} data-tone={toneOfFilter(item.id)}>
                      <Icon name={item.icon} size={15} />
                    </span>
                    <span className={styles.filterLabel}>
                      {item.id === "all" ? <T>All tasks</T> : t(GROUP_LABEL_KEY[item.id])}
                    </span>
                    <span className={styles.filterCount}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.railSection}>
            <div className={styles.sectionLabel}>
              <T>Projects</T>
            </div>
            <div className={styles.filterList}>
              <button
                type="button"
                className={styles.filterButton}
                data-active={project === null}
                aria-pressed={project === null}
                onClick={() => setProject(null)}
              >
                <span className={styles.filterIcon}>
                  <Icon name="folder" size={15} />
                </span>
                <span className={styles.filterLabel}>
                  <T>All projects</T>
                </span>
              </button>
              {DEMO_PROJECTS.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={styles.filterButton}
                  data-active={project === name}
                  aria-pressed={project === name}
                  onClick={() => setProject(name)}
                >
                  <span className={styles.projectMonogram} aria-hidden="true">
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={styles.filterLabel}>{name}</span>
                  <span className={styles.filterCount}>{countTasks((task) => task.project === name)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.railFooter}>
            <div className={styles.railNote}>
              <span className={styles.railNoteIcon}>
                <Icon name="info" size={14} />
              </span>
              <span>
                <T>Frontend preview. The ACP host is not connected yet.</T>
              </span>
            </div>
          </div>
        </aside>

        <section className={styles.listPanel} aria-label={tx("Tasks")}>
          <div className={styles.listHeader}>
            <div className={styles.listHeading}>
              <div className={styles.listEyebrow}>
                <span className={styles.liveDot} />
                <T>Inbox</T>
              </div>
              <div className={styles.listTitleRow}>
                <h2 className={styles.listTitle}>
                  <T>Tasks</T>
                </h2>
                <span className={styles.listCount}>{filtered.length}</span>
                <span className={styles.listHint}>
                  <T>Grouped by attention</T>
                </span>
              </div>
            </div>
            <label className={styles.searchBox}>
              <Icon name="search" size={15} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tx("Search tasks")}
                aria-label={tx("Search tasks")}
              />
              {query ? (
                <button
                  type="button"
                  className={styles.clearSearch}
                  aria-label={tx("Clear search")}
                  onClick={() => setQuery("")}
                >
                  <Icon name="close" size={12} />
                </button>
              ) : (
                <span className={styles.searchShortcut} aria-hidden="true">
                  /
                </span>
              )}
            </label>
          </div>

          <div className={styles.groups}>
            {grouped.length ? (
              grouped.map(({ group, tasks }) => (
                <div key={group} className={styles.group}>
                  <div className={styles.groupHeader}>
                    <span className={styles.groupDot} data-tone={toneOfFilter(group)} />
                    <span>{t(GROUP_LABEL_KEY[group])}</span>
                    <span className={styles.groupLine} />
                    <span className={styles.groupCount}>{tasks.length}</span>
                  </div>
                  {tasks.map((task, index) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      index={index}
                      selected={task.id === activeTask?.id}
                      onSelect={() => selectTask(task.id)}
                    />
                  ))}
                </div>
              ))
            ) : (
              <div className={styles.emptyList}>
                <span className={styles.emptyIcon}>
                  <Icon name="search" size={26} />
                </span>
                <div className={styles.emptyTitle}>
                  <T>No tasks match these filters</T>
                </div>
                <Button icon="refresh" onClick={clearFilters}>
                  <T>Clear filters</T>
                </Button>
              </div>
            )}
          </div>
        </section>

        {activeTask ? (
          <TaskDetail
            task={activeTask}
            replies={replies[activeTask.id] ?? []}
            reply={reply}
            replyRef={replyRef}
            notice={notice}
            onReplyChange={setReply}
            onSend={sendReply}
            onFocusReply={() => replyRef.current?.focus()}
            onNotice={showNotice}
          />
        ) : (
          <section className={styles.emptyDetail}>
            <span className={styles.emptyIcon}>
              <Icon name="toolwindow-pull-requests" size={30} />
            </span>
            <T>Select a task to see its review workspace</T>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusMeter({ status, count }: { status: AgentTaskStatus; count: number }) {
  const t = useT();
  return (
    <div className={styles.statusMeter} data-tone={status}>
      <span className={styles.statusMeterIcon}>
        <Icon name={STATUS_ICON[status]} size={14} />
      </span>
      <span className={styles.statusMeterLabel}>{t(STATUS_LABEL_KEY[status])}</span>
      <strong>{count}</strong>
    </div>
  );
}

function TaskCard({
  task,
  index,
  selected,
  onSelect,
}: {
  task: AgentCenterTask;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.taskCard}
      data-status={task.status}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      style={{ "--agent-index": index } as CSSProperties}
    >
      <span className={styles.taskStatusIcon} data-tone={task.status}>
        <Icon name={STATUS_ICON[task.status]} size={15} />
      </span>
      <span className={styles.taskBody}>
        <span className={styles.taskTop}>
          <span className={styles.taskTitle}>{task.taskTitle}</span>
          <span className={styles.taskProject}>{task.project}</span>
        </span>
        <span className={styles.taskSummary}>{task.summary}</span>
        <span className={styles.taskMeta}>
          <span className={styles.providerChip}>{task.provider}</span>
          <span className={styles.branchChip}>
            <Icon name="branch" size={11} />
            {task.branch}
          </span>
          <span className={styles.changeCount}>
            <Icon name="diff" size={11} />
            {task.changes.length}
          </span>
          <span className={styles.taskTime}>{task.updated}</span>
        </span>
      </span>
    </button>
  );
}

function TaskDetail({
  task,
  replies,
  reply,
  replyRef,
  notice,
  onReplyChange,
  onSend,
  onFocusReply,
  onNotice,
}: {
  task: AgentCenterTask;
  replies: readonly string[];
  reply: string;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  notice: DemoNotice | null;
  onReplyChange: (value: string) => void;
  onSend: () => void;
  onFocusReply: () => void;
  onNotice: (notice: DemoNotice) => void;
}) {
  const t = useT();
  const tx = useTx();

  return (
    <article className={styles.detail} aria-label={task.taskTitle}>
      <div className={styles.detailScroll}>
        <header className={styles.detailHeader}>
          <span className={styles.detailStatusIcon} data-tone={task.status}>
            <Icon name={STATUS_ICON[task.status]} size={20} />
          </span>
          <div className={styles.detailHeading}>
            <div className={styles.detailEyebrow}>
              <span className={styles.statusBadge} data-tone={task.status}>
                <span className={styles.statusBadgeDot} />
                {t(STATUS_LABEL_KEY[task.status])}
              </span>
              <span className={styles.detailProject}>{task.project}</span>
              <span className={styles.detailUpdated}>{task.updated}</span>
            </div>
            <h2 className={styles.detailTitle}>{task.taskTitle}</h2>
            <div className={styles.detailPath} title={task.projectPath}>
              <Icon name="folder" size={12} />
              {task.projectPath}
            </div>
          </div>
        </header>

        <div className={styles.metaGrid}>
          <MetaTile label="Project" value={task.project} />
          <MetaTile label="Provider" value={`${task.provider} · ${task.model}`} />
          <MetaTile label="Branch" value={task.branch} mono />
          <MetaTile label="Worktree" value={task.projectPath} mono />
        </div>

        {typeof task.progress === "number" && (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>
              <span>
                <T>Progress</T>
              </span>
              <strong>{task.progress}%</strong>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={task.progress}
            >
              <span style={{ width: `${task.progress}%` }} />
            </div>
          </div>
        )}

        <section className={styles.summaryBlock}>
          <div className={styles.blockKicker}>
            <T>Task summary</T>
          </div>
          <p>{task.summary}</p>
        </section>

        <section className={styles.nextStep} data-tone={task.status}>
          <div className={styles.nextStepHeader}>
            <span className={styles.nextStepIcon}>
              <Icon name={STATUS_ICON[task.status]} size={17} />
            </span>
            <div>
              <div className={styles.blockKicker}>
                <T>Next step</T>
              </div>
              <div className={styles.nextStepText}>{task.nextStep}</div>
            </div>
          </div>
          {task.failure && (
            <div className={styles.issueBox}>
              <Icon name="error" size={14} />
              <span>{task.failure}</span>
            </div>
          )}
          {task.reset && (
            <div className={styles.issueBox} data-tone="warning">
              <Icon name="clock" size={14} />
              <span>{task.reset}</span>
            </div>
          )}
          <div className={styles.actionRow}>
            {(task.status === "needs-input" || task.status === "running") && (
              <Button icon="review-comment" variant="primary" onClick={onFocusReply}>
                <T>Reply to agent</T>
              </Button>
            )}
            {(task.status === "needs-input" || task.status === "ready") && (
              <Button icon="check" onClick={() => onNotice("approve")}>
                <T>Approve changes</T>
              </Button>
            )}
            {(task.status === "ready" || task.status === "running") && (
              <Button icon="diff" onClick={() => onNotice("reviewDiff")}>
                <T>Review diff</T>
              </Button>
            )}
            {task.status === "failed" && (
              <Button icon="rerun" variant="primary" onClick={() => onNotice("retry")}>
                <T>Retry task</T>
              </Button>
            )}
            {task.status === "limited" && (
              <Button icon="refresh" variant="primary" onClick={() => onNotice("retry")}>
                <T>Resume when ready</T>
              </Button>
            )}
            <Button icon="folder-open" onClick={() => onNotice("openWorktree")}>
              <T>Open worktree</T>
            </Button>
            {(task.status === "ready" || task.status === "failed") && (
              <Button icon="run" onClick={() => onNotice("runTests")}>
                <T>Run tests</T>
              </Button>
            )}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3>
              <T>Changed files</T>
            </h3>
            <span className={styles.sectionCount}>{task.changes.length}</span>
          </div>
          <div className={styles.files}>
            {task.changes.map((change) => (
              <button
                key={change.path}
                type="button"
                className={styles.fileRow}
                title={change.path}
                onClick={() => onNotice("reviewDiff")}
              >
                <span className={styles.fileIcon}>
                  <Icon name={fileIcon(change.path)} size={14} />
                </span>
                <span className={styles.filePath}>{change.path}</span>
                <span className={styles.fileStats}>
                  <span className={styles.added}>+{change.additions}</span>
                  <span className={styles.deleted}>-{change.deletions}</span>
                </span>
                <span className={styles.fileOpen}>
                  <Icon name="chevron-right" size={12} />
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3>
              <T>Activity</T>
            </h3>
          </div>
          <div className={styles.timeline}>
            {task.timeline.map((event, index) => (
              <div key={`${event.at}-${index}`} className={styles.timelineItem} data-tone={event.tone}>
                <span className={styles.timelineDot} />
                <div className={styles.timelineCopy}>
                  <div className={styles.timelineText}>{event.event}</div>
                  <div className={styles.timelineAt}>{event.at}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3>
              <T>Agent note</T>
            </h3>
          </div>
          <blockquote className={styles.agentNote}>
            <span className={styles.agentNoteIcon}>
              <Icon name="review-comment" size={15} />
            </span>
            <p>{task.agentNote}</p>
          </blockquote>
          {replies.length > 0 && (
            <div className={styles.replyHistory}>
              <div className={styles.blockKicker}>
                <T>Your replies</T>
              </div>
              {replies.map((text, index) => (
                <div key={`${text}-${index}`} className={styles.replyBubble}>
                  {text}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className={styles.composer}>
        <div className={styles.composerHeader}>
          <div className={styles.composerTitle}>
            <span className={styles.composerAvatar}>
              <Icon name="review-comment" size={13} />
            </span>
            <span>
              <T>Reply to the agent</T>
            </span>
          </div>
          <span className={styles.composerContext}>{task.project}</span>
        </div>
        <textarea
          ref={replyRef}
          value={reply}
          onChange={(event) => onReplyChange(event.target.value)}
          placeholder={tx("Write a reply or decision")}
          aria-label={tx("Reply to the agent")}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className={styles.composerFooter}>
          <span className={styles.composerHint}>
            <T>Replies stay with this task, not in a global chat.</T>
          </span>
          <Button icon="send" variant="primary" disabled={!reply.trim()} onClick={onSend}>
            <T>Send</T>
          </Button>
        </div>
        {notice && (
          <div className={styles.notice} role="status">
            <Icon name="info" size={13} />
            <span>{t(NOTICE_KEY[notice])}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function MetaTile({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.metaTile}>
      <div className={styles.metaLabel}>
        <T>{label}</T>
      </div>
      <div className={clsx(styles.metaValue, mono && styles.mono)} title={value}>
        {value}
      </div>
    </div>
  );
}
