/** Turn-aware ledger over a task's entries: turns, tool records and a timing overview.
 *
 * Frontend-only: the backend keeps no per-record timing yet, so the overview
 * spans user turns and subagents (the entries that carry timestamps) while
 * tool calls appear as records inside their turn.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentEntry, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { EmptyState, Icon, IconButton, SearchField, Spinner, T, fileIconName } from "@/ui";
import { formatDuration, formatSentAt } from "./conversation";
import { Markdown } from "./Markdown";
import { isBusy, subagentTitle, subagentWorking, type SubagentEntry } from "./model";
import { buildTrajectory, buildTrajectorySpans, matchTrajectoryEntry, trajectoryDomain } from "./trajectory";
import styles from "./TrajectoryView.module.css";

const TOOL_ICONS: Record<string, string> = {
  read: "file",
  edit: "edit",
  delete: "minus",
  move: "edit",
  search: "search",
  execute: "terminal",
  fetch: "web",
  think: "todo",
};

/** `Date.now()`, updated every `interval` ms. */
function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useLayoutEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

export function TrajectoryView({
  task,
  entries,
  onOpenSubagent,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  onOpenSubagent: (id: string) => void;
}) {
  const tx = useTx();
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const trajectory = useMemo(() => buildTrajectory(entries ?? []), [entries]);
  const busy = isBusy(task.status);
  const now = useNow(busy ? 1000 : 60_000);
  const spans = useMemo(() => buildTrajectorySpans(entries ?? [], trajectory.turns), [entries, trajectory.turns]);
  const domain = useMemo(() => trajectoryDomain(spans, now), [spans, now]);
  const q = query.trim();
  const matching = useMemo(() => {
    if (!entries || !q) return null;
    const found = new Set<number>();
    entries.forEach((e, i) => {
      if (matchTrajectoryEntry(e, q)) found.add(i);
    });
    return found;
  }, [entries, q]);
  const matchCount = matching?.size ?? 0;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow && stick.current) el.scrollTop = el.scrollHeight;
  });

  if (entries === null) {
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  }
  if (entries.length === 0) return <EmptyState title="No activity yet" />;
  if (matching?.size === 0)
    return (
      <div className={styles.view}>
        <Toolbar query={query} onQuery={setQuery} matchCount={0} follow={follow} onFollow={setFollow} />
        <EmptyState title="No matching records" />
      </div>
    );

  const anchorOf = (turn: number) => `traj-turn-${turn}`;
  const goToTurn = (turn: number) => {
    // `scrollIntoView` is absent in jsdom; the optional call keeps tests honest.
    document.getElementById(anchorOf(turn))?.scrollIntoView?.({ block: "nearest" });
  };
  return (
    <div className={styles.view}>
      <Toolbar query={query} onQuery={setQuery} matchCount={matchCount} follow={follow} onFollow={setFollow} />
      {domain && (
        <div className={styles.overview} role="group" aria-label={tx("Timing overview")}>
          {spans.map((s) => {
            const left = ((s.startMs - domain.start) / (domain.end - domain.start)) * 100;
            const width = Math.max((((s.endMs ?? now) - s.startMs) / (domain.end - domain.start)) * 100, 1.2);
            return (
              <button
                key={s.key}
                type="button"
                className={clsx(
                  styles.span,
                  s.kind === "subagent" && styles.spanSubagent,
                  s.endMs == null && styles.spanRunning,
                )}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${formatSentAt(s.startMs)} - ${formatSentAt(s.endMs ?? now)}`}
                aria-label={s.kind === "turn" ? tx`Turn ${s.turn! + 1}` : (s.title ?? tx("Subagent"))}
                onClick={() => {
                  if (s.kind === "turn" && s.turn != null) goToTurn(s.turn);
                  else if (s.subagent) onOpenSubagent(s.subagent);
                }}
              />
            );
          })}
        </div>
      )}
      <div
        ref={listRef}
        className={styles.ledger}
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = atBottom;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {trajectory.prefaceEnd > 0 && (
          <div className={styles.rows}>
            {entries
              .slice(0, trajectory.prefaceEnd)
              .map((entry, i) =>
                matching && !matching.has(i) ? null : (
                  <Row key={i} task={task} entry={entry} onOpenSubagent={onOpenSubagent} />
                ),
              )}
          </div>
        )}
        {trajectory.turns.map((t) => {
          if (matching && !matching.has(t.startIndex) && !hasMatchInRange(matching, t.startIndex + 1, t.endIndex)) {
            return null;
          }
          return (
            <section key={t.turn} id={anchorOf(t.turn)} aria-label={tx`Turn ${t.turn + 1}`} className={styles.turn}>
              <div className={styles.turnHead}>
                <span className={styles.turnTitle}>{tx`Turn ${t.turn + 1}`}</span>
                {t.durationMs != null && (
                  <span className={styles.turnMeta} title={tx("Time the agent took to answer")}>
                    {formatDuration(t.durationMs)}
                  </span>
                )}
                {t.counts.tools > 0 && (
                  <span className={styles.turnMeta}>
                    {t.counts.tools} {tx(t.counts.tools === 1 ? "tool call" : "tool calls")}
                  </span>
                )}
                {t.counts.errors > 0 && (
                  <span className={styles.turnMeta}>
                    {t.counts.errors} {tx(t.counts.errors === 1 ? "error" : "errors")}
                  </span>
                )}
              </div>
              <div className={styles.turnUser}>
                {t.text}
                {t.attachments.length > 0 && (
                  <div className={styles.attachments}>
                    {t.attachments.map((a, i) => (
                      <span key={i} className={styles.attachment}>
                        <Icon name={fileIconName(a)} size={12} />
                        {a}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className={styles.rows}>
                {entries.slice(t.startIndex + 1, t.endIndex).map((entry, k) => {
                  const index = t.startIndex + 1 + k;
                  return matching && !matching.has(index) ? null : (
                    <Row key={index} task={task} entry={entry} onOpenSubagent={onOpenSubagent} />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function hasMatchInRange(matching: Set<number>, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (matching.has(i)) return true;
  return false;
}

function Toolbar({
  query,
  onQuery,
  matchCount,
  follow,
  onFollow,
}: {
  query: string;
  onQuery: (q: string) => void;
  matchCount: number;
  follow: boolean;
  onFollow: (follow: boolean) => void;
}) {
  const tx = useTx();
  return (
    <div className={styles.toolbar}>
      <SearchField
        value={query}
        onChange={onQuery}
        aria-label={tx("Search trajectory")}
        placeholder={tx("Search trajectory")}
        className={styles.search}
        trailing={query.trim() ? <span className={styles.count}>{matchCount}</span> : null}
      />
      <IconButton
        icon="autoscroll-to-source"
        title={follow ? tx("Stop following") : tx("Follow new activity")}
        size="small"
        pressed={follow}
        onClick={() => onFollow(!follow)}
      />
    </div>
  );
}

function Row({
  task,
  entry,
  onOpenSubagent,
}: {
  task: AgentTask;
  entry: AgentEntry;
  onOpenSubagent: (id: string) => void;
}) {
  switch (entry.type) {
    case "user":
      return null;
    case "agent":
      return <AgentRow task={task} text={entry.text} />;
    case "thought":
      return (
        <details className={styles.row}>
          <summary className={styles.thoughtSummary}>
            <T>Thinking</T>
          </summary>
          <div className={styles.thought}>{entry.text}</div>
        </details>
      );
    case "tool":
      return <ToolRow entry={entry} />;
    case "plan":
      return (
        <div className={styles.row}>
          <div className={styles.rowHead}>
            <T>Plan</T>
          </div>
          {entry.items.map((item, i) => (
            <div key={i} className={styles.rowHead}>
              <Icon
                name={item.status === "completed" ? "check" : item.status === "in_progress" ? "run" : "minus"}
                size={12}
              />
              <span className={styles.rowTitle}>{item.content}</span>
            </div>
          ))}
        </div>
      );
    case "subagent":
      return <SubagentRow task={task} entry={entry} onOpen={onOpenSubagent} />;
    case "message":
      return (
        <div className={styles.row}>
          <div className={styles.messageLabel}>
            {entry.incoming ? <T>Task from the parent agent</T> : <T>Report to the parent agent</T>}
          </div>
          {entry.incoming ? (
            <div className={styles.messageText}>{entry.text}</div>
          ) : (
            <Markdown text={entry.text} cwd={task.cwd} />
          )}
        </div>
      );
    case "permission":
      return (
        <div className={styles.row}>
          <div className={styles.rowHead}>
            <Icon name="warning" size={13} />
            <span className={styles.rowTitle}>{entry.title}</span>
            <span className={styles.rowMeta}>{entry.chosen ?? <T>Waiting for your answer</T>}</span>
          </div>
        </div>
      );
    case "error":
      return (
        <div className={styles.errorRow} role="alert">
          <Icon name="error" size={14} />
          <span>{entry.message}</span>
        </div>
      );
  }
}

function AgentRow({ task, text }: { task: AgentTask; text: string }) {
  const firstLine = text.split("\n", 1)[0]!.slice(0, 140);
  if (text.length <= 140 && !text.includes("\n")) return <Markdown text={text} cwd={task.cwd} />;
  return (
    <details className={styles.row}>
      <summary className={styles.rowHead}>
        <span className={styles.rowTitle}>{firstLine}</span>
      </summary>
      <Markdown text={text} cwd={task.cwd} />
    </details>
  );
}

function ToolRow({ entry }: { entry: Extract<AgentEntry, { type: "tool" }> }) {
  const head = (
    <>
      <Icon name={TOOL_ICONS[entry.kind] ?? "run"} size={14} />
      <span className={styles.rowTitle}>{entry.title || entry.kind}</span>
      {entry.diffs.map((d) => (
        <span key={d.path} className={styles.rowMeta}>
          +{d.added} -{d.removed}
        </span>
      ))}
      {(entry.status === "running" || entry.status === "pending") && <Spinner size={12} />}
      {entry.status === "failed" && <Icon name="error" size={12} />}
    </>
  );
  if (!entry.output) {
    return (
      <div className={styles.row}>
        <div className={styles.rowHead}>{head}</div>
      </div>
    );
  }
  return (
    <details className={styles.row}>
      <summary className={clsx(styles.rowHead, styles.rowTitle)}>{head}</summary>
      <div className={styles.inspect}>
        <span>
          <code className={styles.code}>{entry.kind}</code> <code className={styles.code}>{entry.status}</code>
        </span>
        <pre className={styles.output}>{entry.output}</pre>
      </div>
    </details>
  );
}

function SubagentRow({ task, entry, onOpen }: { task: AgentTask; entry: SubagentEntry; onOpen: (id: string) => void }) {
  const tx = useTx();
  const working = subagentWorking(entry.status);
  const now = useNow(working ? 1000 : 60_000);
  const time = entry.startedMs == null ? null : (entry.endedMs ?? now) - entry.startedMs;
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <SubagentStatusIcon status={entry.status} />
        <button
          type="button"
          className={styles.subagentOpen}
          onClick={() => onOpen(entry.id)}
          title={tx("Open the subagent's conversation")}
        >
          {subagentTitle(entry)}
        </button>
        <span className={styles.rowMeta}>
          {[
            entry.tools > 0 && `${entry.tools} ${tx(entry.tools === 1 ? "tool call" : "tool calls")}`,
            time != null && formatDuration(Math.max(0, time)),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {entry.prompt && (
        <details>
          <summary className={styles.thoughtSummary}>
            <T>Task</T>
          </summary>
          <div className={styles.thought}>{entry.prompt}</div>
        </details>
      )}
      {entry.reply && (
        <details>
          <summary className={styles.thoughtSummary}>
            <T>Result</T>
          </summary>
          <Markdown text={entry.reply} cwd={task.cwd} />
        </details>
      )}
    </div>
  );
}

function SubagentStatusIcon({ status }: { status: SubagentEntry["status"] }) {
  switch (status) {
    case "running":
      return <Spinner size={11} />;
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "done":
      return <Icon name="check" size={13} className={styles.muted} label="Done" />;
    case "cancelled":
      return <Icon name="minus" size={13} className={styles.muted} label="Stopped" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.muted} label="Failed" />;
  }
}
