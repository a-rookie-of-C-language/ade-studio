/** Turn-aware ledger over a task's entries: turns, tool records and a timing overview.
 *
 * The timing overview spans turns, timed tool calls and subagents; tool calls
 * also appear as records inside their turn, and the sequence overview gives
 * every record an equal-width lane.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentEntry, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { EmptyState, Icon, IconButton, SearchField, Spinner, T, copyText, fileIconName } from "@/ui";
import { formatDuration, formatSentAt } from "./conversation";
import { Markdown } from "./Markdown";
import { isBusy, subagentTitle, subagentWorking, type SubagentEntry } from "./model";
import {
  buildTrajectory,
  buildTrajectorySpans,
  buildSequenceSpans,
  describeTrajectoryRecord,
  matchTrajectoryEntry,
  trajectoryCopyText,
  trajectoryDomain,
  turnOfIndex,
  type TrajectoryInspector,
  type TrajectoryInspectorFact,
  type TrajectoryInspectorText,
  type TrajectoryTimelineMode,
} from "./trajectory";
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
  const [mode, setMode] = useState<TrajectoryTimelineMode>("sequence");
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const trajectory = useMemo(() => buildTrajectory(entries ?? []), [entries]);
  const busy = isBusy(task.status);
  const now = useNow(busy ? 1000 : 60_000);
  const spans = useMemo(() => buildTrajectorySpans(entries ?? [], trajectory.turns), [entries, trajectory.turns]);
  const domain = useMemo(() => trajectoryDomain(spans, now), [spans, now]);
  const seqSpans = useMemo(() => buildSequenceSpans(entries ?? [], trajectory.turns), [entries, trajectory.turns]);
  const seqTotal = seqSpans.length > 0 ? seqSpans[seqSpans.length - 1]!.end : 0;
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
  // A search shows every match; folding only applies to the unfiltered ledger.
  const searching = matching !== null;
  const toggleTurn = (turn: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  const allCollapsed = trajectory.turns.length > 0 && trajectory.turns.every((t) => collapsed.has(t.turn));
  const toggleAllTurns = () =>
    setCollapsed((prev) => {
      if (trajectory.turns.length > 0 && trajectory.turns.every((t) => prev.has(t.turn))) return new Set();
      return new Set(trajectory.turns.map((t) => t.turn));
    });

  const toggleInspect = (index: number) => setSelected((s) => (s === index ? null : index));
  const selectedEntry = selected != null ? (entries ?? [])[selected] : undefined;
  const selectedDetail = selectedEntry ? describeTrajectoryRecord(selectedEntry) : null;
  const selectedTurn = selected != null ? turnOfIndex(trajectory.turns, selected) : null;
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
        <Toolbar
          query={query}
          onQuery={setQuery}
          matchCount={0}
          follow={follow}
          onFollow={setFollow}
          allCollapsed={allCollapsed}
          onToggleAll={toggleAllTurns}
          mode={mode}
          onToggleMode={() => setMode((m) => (m === "sequence" ? "time" : "sequence"))}
        />
        <EmptyState title="No matching records" />
      </div>
    );

  const anchorOf = (turn: number) => "traj-turn-" + String(turn);
  const recordAnchorOf = (index: number) => "traj-record-" + String(index);
  const goToRecord = (index: number, turn: number | null) => {
    if (turn != null) {
      setCollapsed((prev) => {
        if (!prev.has(turn)) return prev;
        const next = new Set(prev);
        next.delete(turn);
        return next;
      });
    }
    document.getElementById(recordAnchorOf(index))?.scrollIntoView?.({ block: "nearest" });
  };
  const goToTurn = (turn: number) => {
    // Jumping from the overview unfolds the turn first.
    setCollapsed((prev) => {
      if (!prev.has(turn)) return prev;
      const next = new Set(prev);
      next.delete(turn);
      return next;
    });
    // `scrollIntoView` is absent in jsdom; the optional call keeps tests honest.
    document.getElementById(anchorOf(turn))?.scrollIntoView?.({ block: "nearest" });
  };
  return (
    <div
      className={styles.view}
      onKeyDown={(e) => {
        if (e.key === "Escape") setSelected(null);
      }}
    >
      <Toolbar
        query={query}
        onQuery={setQuery}
        matchCount={matchCount}
        follow={follow}
        onFollow={setFollow}
        allCollapsed={allCollapsed}
        onToggleAll={toggleAllTurns}
        mode={mode}
        onToggleMode={() => setMode((m) => (m === "sequence" ? "time" : "sequence"))}
      />
      {mode === "sequence" && seqTotal > 0 && (
        <div className={styles.overview} role="group" aria-label={tx("Sequence overview")}>
          {seqSpans.map((s) => {
            const left = (s.start / seqTotal) * 100;
            const width = Math.max(((s.end - s.start) / seqTotal) * 100, 1.2);
            return (
              <button
                key={s.key}
                type="button"
                className={clsx(
                  styles.span,
                  s.lane === 2 ? styles.seqLane2 : s.lane === 1 ? styles.seqLane1 : styles.seqLane0,
                  s.isError && styles.spanError,
                )}
                style={{ left: left + "%", width: width + "%" }}
                title={"#" + String(s.index + 1) + " " + s.label}
                aria-label={"#" + String(s.index + 1) + " " + s.label}
                onClick={() => goToRecord(s.index, s.turn)}
              />
            );
          })}
        </div>
      )}
      {mode === "time" && domain && (
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
                  s.kind === "tool" && styles.spanTool,
                  s.endMs == null && styles.spanRunning,
                )}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={
                  s.title
                    ? `${s.title} · ${formatSentAt(s.startMs)} - ${formatSentAt(s.endMs ?? now)}`
                    : `${formatSentAt(s.startMs)} - ${formatSentAt(s.endMs ?? now)}`
                }
                aria-label={s.kind === "turn" ? tx`Turn ${s.turn! + 1}` : (s.title ?? tx("Subagent"))}
                onClick={() => {
                  if (s.kind === "turn" && s.turn != null) goToTurn(s.turn);
                  else if (s.kind === "tool") goToRecord(s.index, s.turn);
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
            {entries.slice(0, trajectory.prefaceEnd).map((entry, i) =>
              matching && !matching.has(i) ? null : (
                <div
                  key={i}
                  id={recordAnchorOf(i)}
                  className={clsx(styles.recordAnchor, selected === i && styles.recordSelected)}
                >
                  <Row
                    task={task}
                    entry={entry}
                    index={i}
                    selected={selected === i}
                    onInspect={toggleInspect}
                    onOpenSubagent={onOpenSubagent}
                  />
                </div>
              ),
            )}
          </div>
        )}
        {trajectory.turns.map((t) => {
          if (matching && !matching.has(t.startIndex) && !hasMatchInRange(matching, t.startIndex + 1, t.endIndex)) {
            return null;
          }
          const isCollapsed = !searching && collapsed.has(t.turn);
          return (
            <section key={t.turn} id={anchorOf(t.turn)} aria-label={tx`Turn ${t.turn + 1}`} className={styles.turn}>
              <div className={styles.turnHead}>
                <button
                  type="button"
                  className={styles.turnToggle}
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? tx("Expand turn") : tx("Collapse turn")}
                  onClick={() => toggleTurn(t.turn)}
                >
                  <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={14} />
                </button>
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
                {t.counts.subagents > 0 && (
                  <span className={styles.turnMeta}>
                    {t.counts.subagents} {tx(t.counts.subagents === 1 ? "subagent" : "subagents")}
                  </span>
                )}
                {t.counts.permissions > 0 && (
                  <span className={styles.turnMeta}>
                    {t.counts.permissions} {tx(t.counts.permissions === 1 ? "permission" : "permissions")}
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
              {!isCollapsed && (
                <div className={styles.rows}>
                  {entries.slice(t.startIndex + 1, t.endIndex).map((entry, k) => {
                    const index = t.startIndex + 1 + k;
                    return matching && !matching.has(index) ? null : (
                      <div
                        key={index}
                        id={recordAnchorOf(index)}
                        className={clsx(styles.recordAnchor, selected === index && styles.recordSelected)}
                      >
                        <Row
                          task={task}
                          entry={entry}
                          index={index}
                          selected={selected === index}
                          onInspect={toggleInspect}
                          onOpenSubagent={onOpenSubagent}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {selected != null && selectedEntry && selectedDetail && (
        <Inspector
          task={task}
          index={selected}
          turn={selectedTurn}
          entry={selectedEntry}
          detail={selectedDetail}
          onClose={() => setSelected(null)}
          onOpenSubagent={onOpenSubagent}
        />
      )}
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
  allCollapsed,
  onToggleAll,
  mode,
  onToggleMode,
}: {
  query: string;
  onQuery: (q: string) => void;
  matchCount: number;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  allCollapsed: boolean;
  onToggleAll: () => void;
  mode: "sequence" | "time";
  onToggleMode: () => void;
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
        icon={mode === "sequence" ? "clock" : "github-timeline"}
        title={mode === "sequence" ? tx("Show actual timing") : tx("Show sequence")}
        size="small"
        pressed={mode === "sequence"}
        onClick={onToggleMode}
      />
      <IconButton
        icon={allCollapsed ? "expand-all" : "collapse-all"}
        title={allCollapsed ? tx("Expand turns") : tx("Collapse turns")}
        size="small"
        pressed={allCollapsed}
        onClick={onToggleAll}
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

/** The record's 1-based ledger number; doubles as the inspector toggle. */
function RecordIndex({
  index,
  selected,
  onInspect,
}: {
  index: number;
  selected: boolean;
  onInspect: (index: number) => void;
}) {
  const tx = useTx();
  return (
    <button
      type="button"
      className={clsx(styles.rowIndex, selected && styles.rowIndexSelected)}
      title={tx("Inspect record")}
      aria-pressed={selected}
      onClick={(e) => {
        // Inside a <summary> this would also fold the row; keep it an inspection only.
        e.preventDefault();
        e.stopPropagation();
        onInspect(index);
      }}
    >
      #{index + 1}
    </button>
  );
}

/** Hover action copying the record's full text; absent when there is nothing to copy. */
function RowCopy({ text }: { text: string | null }) {
  const tx = useTx();
  if (text == null) return null;
  return (
    <IconButton
      icon="copy"
      title={tx("Copy")}
      size="small"
      className={styles.rowCopy}
      onClick={() => void copyText(text)}
    />
  );
}

function Row({
  task,
  entry,
  index,
  selected,
  onInspect,
  onOpenSubagent,
}: {
  task: AgentTask;
  entry: AgentEntry;
  index: number;
  selected: boolean;
  onInspect: (index: number) => void;
  onOpenSubagent: (id: string) => void;
}) {
  const copy = trajectoryCopyText(entry);
  switch (entry.type) {
    case "user":
      if (!entry.steered) return null;
      return (
        <div className={styles.row}>
          <RowCopy text={copy} />
          <div className={styles.messageLabel}>
            <RecordIndex index={index} selected={selected} onInspect={onInspect} /> <T>Steered</T>
          </div>
          <div className={styles.messageText}>{entry.text}</div>
        </div>
      );
    case "agent":
      return (
        <AgentRow task={task} text={entry.text} index={index} copy={copy} selected={selected} onInspect={onInspect} />
      );
    case "thought":
      return (
        <details className={styles.row}>
          <RowCopy text={copy} />
          <summary className={styles.rowHead}>
            <RecordIndex index={index} selected={selected} onInspect={onInspect} />
            <span className={styles.thoughtSummary}>
              <T>Thinking</T>
            </span>
          </summary>
          <div className={styles.thought}>{entry.text}</div>
        </details>
      );
    case "tool":
      return <ToolRow entry={entry} index={index} copy={copy} selected={selected} onInspect={onInspect} />;
    case "plan":
      return (
        <div className={styles.row}>
          <RowCopy text={copy} />
          <div className={styles.rowHead}>
            <RecordIndex index={index} selected={selected} onInspect={onInspect} />
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
      return (
        <SubagentRow
          task={task}
          entry={entry}
          index={index}
          copy={copy}
          selected={selected}
          onInspect={onInspect}
          onOpen={onOpenSubagent}
        />
      );
    case "message":
      return (
        <div className={styles.row}>
          <RowCopy text={copy} />
          <div className={styles.messageLabel}>
            <RecordIndex index={index} selected={selected} onInspect={onInspect} />{" "}
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
          <RowCopy text={copy} />
          <div className={styles.rowHead}>
            <RecordIndex index={index} selected={selected} onInspect={onInspect} />
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
          <RecordIndex index={index} selected={selected} onInspect={onInspect} />
          <span>{entry.message}</span>
          <RowCopy text={copy} />
        </div>
      );
  }
}

function AgentRow({
  task,
  text,
  index,
  copy,
  selected,
  onInspect,
}: {
  task: AgentTask;
  text: string;
  index: number;
  copy: string | null;
  selected: boolean;
  onInspect: (index: number) => void;
}) {
  const firstLine = text.split("\n", 1)[0]!.slice(0, 140);
  if (text.length <= 140 && !text.includes("\n"))
    return (
      <div className={styles.row}>
        <RowCopy text={copy} />
        <div className={styles.lineHead}>
          <RecordIndex index={index} selected={selected} onInspect={onInspect} />
          <div className={styles.lineBody}>
            <Markdown text={text} cwd={task.cwd} />
          </div>
        </div>
      </div>
    );
  return (
    <details className={styles.row}>
      <RowCopy text={copy} />
      <summary className={styles.rowHead}>
        <RecordIndex index={index} selected={selected} onInspect={onInspect} />
        <span className={styles.rowTitle}>{firstLine}</span>
      </summary>
      <Markdown text={text} cwd={task.cwd} />
    </details>
  );
}

function ToolRow({
  entry,
  index,
  copy,
  selected,
  onInspect,
}: {
  entry: Extract<AgentEntry, { type: "tool" }>;
  index: number;
  copy: string | null;
  selected: boolean;
  onInspect: (index: number) => void;
}) {
  const durationMs =
    entry.startedMs != null && entry.endedMs != null && entry.endedMs > entry.startedMs
      ? entry.endedMs - entry.startedMs
      : null;
  const head = (
    <>
      <RecordIndex index={index} selected={selected} onInspect={onInspect} />
      <Icon name={TOOL_ICONS[entry.kind] ?? "run"} size={14} />
      <span className={styles.rowTitle}>{entry.title || entry.kind}</span>
      {entry.diffs.map((d) => (
        <span key={d.path} className={styles.rowMeta}>
          +{d.added} -{d.removed}
        </span>
      ))}
      {(entry.status === "running" || entry.status === "pending") && <Spinner size={12} />}
      {entry.status === "failed" && <Icon name="error" size={12} />}
      {durationMs != null && <span className={styles.rowMeta}>{formatDuration(durationMs)}</span>}
    </>
  );
  if (!entry.output) {
    return (
      <div className={styles.row}>
        <RowCopy text={copy} />
        <div className={styles.rowHead}>{head}</div>
      </div>
    );
  }
  return (
    <details className={styles.row}>
      <RowCopy text={copy} />
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

function SubagentRow({
  task,
  entry,
  index,
  copy,
  selected,
  onInspect,
  onOpen,
}: {
  task: AgentTask;
  entry: SubagentEntry;
  index: number;
  copy: string | null;
  selected: boolean;
  onInspect: (index: number) => void;
  onOpen: (id: string) => void;
}) {
  const tx = useTx();
  const working = subagentWorking(entry.status);
  const now = useNow(working ? 1000 : 60_000);
  const time = entry.startedMs == null ? null : (entry.endedMs ?? now) - entry.startedMs;
  return (
    <div className={styles.row}>
      <RowCopy text={copy} />
      <div className={styles.rowHead}>
        <SubagentStatusIcon status={entry.status} />
        <RecordIndex index={index} selected={selected} onInspect={onInspect} />
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

/** Localized label of one inspector fact. */
function InspectorFactLabel({ factKey }: { factKey: TrajectoryInspectorFact["key"] }) {
  const tx = useTx();
  switch (factKey) {
    case "kind":
      return tx("Kind");
    case "locations":
      return tx("Locations");
    case "changes":
      return tx("Changes");
    case "calls":
      return tx("Tool calls");
    case "activity":
      return tx("Latest activity");
    case "error":
      return tx("Error");
    case "attachments":
      return tx("Attachments");
    case "choice":
      return tx("Choice");
    case "options":
      return tx("Options");
  }
}

/** Localized section title of one inspector text ("text" renders untitled). */
function InspectorTextTitle({ textKey }: { textKey: TrajectoryInspectorText["key"] }) {
  const tx = useTx();
  switch (textKey) {
    case "output":
      return tx("Output");
    case "prompt":
      return tx("Task");
    case "reply":
      return tx("Result");
    case "text":
      return null;
  }
}

/** Full detail behind one ledger record: timing, facts, texts and follow-up actions. */
function Inspector({
  task,
  index,
  turn,
  entry,
  detail,
  onClose,
  onOpenSubagent,
}: {
  task: AgentTask;
  index: number;
  turn: number | null;
  entry: AgentEntry;
  detail: TrajectoryInspector;
  onClose: () => void;
  onOpenSubagent: (id: string) => void;
}) {
  const tx = useTx();
  const num = index + 1;
  return (
    <section className={styles.inspector} role="dialog" aria-label={tx`Record ${num}`}>
      <div className={styles.inspectorHead}>
        <span className={styles.rowIndex}>#{num}</span>
        {detail.title ? (
          <span className={styles.inspectorTitle}>{detail.title}</span>
        ) : (
          <code className={styles.code}>{detail.kind}</code>
        )}
        {detail.status && <code className={styles.code}>{detail.status}</code>}
        {turn != null && <span className={styles.turnMeta}>{tx`Turn ${turn + 1}`}</span>}
        <span className={styles.inspectorSpacer} />
        <IconButton icon="close" title={tx("Close")} size="small" onClick={onClose} />
      </div>
      {(detail.startMs != null || detail.facts.length > 0) && (
        <dl className={styles.facts}>
          {detail.startMs != null && (
            <div className={styles.fact}>
              <dt>{tx("Started")}</dt>
              <dd>{formatSentAt(detail.startMs)}</dd>
            </div>
          )}
          {detail.startMs != null && (
            <div className={styles.fact}>
              <dt>{tx("Ended")}</dt>
              <dd>{detail.endMs != null ? formatSentAt(detail.endMs) : tx("Running")}</dd>
            </div>
          )}
          {detail.durationMs != null && (
            <div className={styles.fact}>
              <dt>{tx("Duration")}</dt>
              <dd>{formatDuration(detail.durationMs)}</dd>
            </div>
          )}
          {detail.facts.map((f) => (
            <div key={f.key} className={styles.fact}>
              <dt>
                <InspectorFactLabel factKey={f.key} />
              </dt>
              <dd className={styles.factValue}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.type === "permission" && !detail.facts.some((f) => f.key === "choice") && (
        <div className={styles.pending}>{tx("Waiting for your answer")}</div>
      )}
      {detail.texts.map((t) => (
        <div key={t.key} className={styles.section}>
          {t.key !== "text" && (
            <div className={styles.sectionTitle}>
              <InspectorTextTitle textKey={t.key} />
            </div>
          )}
          {t.format === "markdown" ? (
            <Markdown text={t.text} cwd={task.cwd} />
          ) : t.format === "pre" ? (
            <pre className={styles.output}>{t.text}</pre>
          ) : (
            <div className={styles.messageText}>{t.text}</div>
          )}
        </div>
      ))}
      {entry.type === "subagent" && (
        <div>
          <button
            type="button"
            className={styles.subagentOpen}
            onClick={() => onOpenSubagent(entry.id)}
            title={tx("Open the subagent's conversation")}
          >
            {subagentTitle(entry)}
          </button>
        </div>
      )}
    </section>
  );
}
