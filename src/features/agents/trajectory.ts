/** Frontend-only trajectory projection over a task's flat entries.
 *
 * The backend keeps no per-record timing yet (tools carry no timestamps and
 * outputs are truncated), so the overview below only spans what the entries
 * do timestamp: user turns (`sentMs`/`doneMs`) and subagents
 * (`startedMs`/`endedMs`). Tool calls appear as records inside their turn.
 */
import type { AgentEntry } from "@/bindings";
import { turnNumbers } from "./model";

export interface TrajectoryTurnCounts {
  tools: number;
  subagents: number;
  errors: number;
  permissions: number;
}

export interface TrajectoryTurn {
  /** 0-based turn number. */
  turn: number;
  /** Index of the turn's user message. */
  startIndex: number;
  /** One past the turn's last entry. */
  endIndex: number;
  text: string;
  attachments: string[];
  sentMs: number | null;
  doneMs: number | null;
  durationMs: number | null;
  counts: TrajectoryTurnCounts;
}

export interface TrajectorySpan {
  key: string;
  kind: "turn" | "subagent";
  /** Owning turn (the latest one started at the record's index); null before the first turn. */
  turn: number | null;
  startMs: number;
  /** Null while the turn or subagent is still running. */
  endMs: number | null;
  /** The subagent's session id; null for turns. */
  subagent: string | null;
  /** The subagent's title; null for turns. */
  title: string | null;
  status: string;
}

export interface Trajectory {
  turns: TrajectoryTurn[];
  /** Entries before the first turn (usually empty). */
  prefaceEnd: number;
}

const noCounts = (): TrajectoryTurnCounts => ({ tools: 0, subagents: 0, errors: 0, permissions: 0 });

/** Group `entries` into turns; entries before the first turn stay outside any turn. */
export function buildTrajectory(entries: readonly AgentEntry[]): Trajectory {
  const starts = turnNumbers(entries as AgentEntry[]);
  const ordered = [...starts.entries()].sort((a, b) => a[0] - b[0]);
  const turns: TrajectoryTurn[] = ordered.map(([startIndex, turn], n) => {
    const entry = entries[startIndex]!;
    const endIndex = n + 1 < ordered.length ? ordered[n + 1]![0] : entries.length;
    const counts = noCounts();
    for (let i = startIndex + 1; i < endIndex; i++) {
      const e = entries[i]!;
      if (e.type === "tool") counts.tools++;
      else if (e.type === "subagent") counts.subagents++;
      else if (e.type === "error") counts.errors++;
      else if (e.type === "permission") counts.permissions++;
    }
    const sentMs = entry.type === "user" ? (entry.sentMs ?? null) : null;
    const doneMs = entry.type === "user" ? (entry.doneMs ?? null) : null;
    return {
      turn,
      startIndex,
      endIndex,
      text: entry.type === "user" ? entry.text : "",
      attachments: entry.type === "user" ? entry.attachments : [],
      sentMs,
      doneMs,
      durationMs: sentMs != null && doneMs != null && doneMs > sentMs ? doneMs - sentMs : null,
      counts,
    };
  });
  return { turns, prefaceEnd: ordered.length ? ordered[0]![0] : entries.length };
}

/** The latest turn started at or before `index`; null before the first turn. */
export function turnOfIndex(turns: readonly TrajectoryTurn[], index: number): number | null {
  let out: number | null = null;
  for (const t of turns) {
    if (t.startIndex > index) break;
    out = t.turn;
  }
  return out;
}

/** Timed spans for the overview: turns plus every subagent card. */
export function buildTrajectorySpans(
  entries: readonly AgentEntry[],
  turns: readonly TrajectoryTurn[],
): TrajectorySpan[] {
  const spans: TrajectorySpan[] = [];
  for (const t of turns) {
    if (t.sentMs == null) continue;
    spans.push({
      key: `turn-${t.turn}`,
      kind: "turn",
      turn: t.turn,
      startMs: t.sentMs,
      endMs: t.doneMs,
      subagent: null,
      title: null,
      status: t.doneMs == null ? "running" : "done",
    });
  }
  entries.forEach((e, i) => {
    if (e.type !== "subagent" || e.startedMs == null) return;
    spans.push({
      key: `subagent-${e.id}`,
      kind: "subagent",
      turn: turnOfIndex(turns, i),
      startMs: e.startedMs,
      endMs: e.endedMs,
      subagent: e.id,
      title: e.title ?? e.description,
      status: e.status,
    });
  });
  return spans.sort((a, b) => a.startMs - b.startMs);
}

/** Time domain of `spans`; open ends count up to `now`. Null when nothing is timed. */
export function trajectoryDomain(spans: readonly TrajectorySpan[], now: number): { start: number; end: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const s of spans) {
    start = start == null ? s.startMs : Math.min(start, s.startMs);
    const e = s.endMs ?? now;
    end = end == null ? e : Math.max(end, e);
  }
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

/** Searchable text of one entry: titles, bodies, outputs and reports. */
export function trajectoryEntryText(entry: AgentEntry): string {
  switch (entry.type) {
    case "user":
      return [entry.text, ...entry.attachments].join("\n");
    case "agent":
    case "thought":
      return entry.text;
    case "tool":
      return [entry.title, entry.kind, entry.output ?? ""].join("\n");
    case "plan":
      return entry.items.map((i) => i.content).join("\n");
    case "subagent":
      return [
        entry.title ?? "",
        entry.description ?? "",
        entry.prompt ?? "",
        entry.reply ?? "",
        entry.activity ?? "",
      ].join("\n");
    case "message":
      return entry.text;
    case "permission":
      return entry.title;
    case "error":
      return entry.message;
  }
}

/** Split a search query into case-insensitive AND terms; empty when there is no query. */
export function trajectoryQueryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether `entry` matches every term of `query` (empty matches all). */
export function matchTrajectoryEntry(entry: AgentEntry, query: string): boolean {
  const terms = trajectoryQueryTerms(query);
  if (terms.length === 0) return true;
  const text = trajectoryEntryText(entry).toLowerCase();
  return terms.every((t) => text.includes(t));
}

/** Full text worth copying for `entry`; null when the record carries nothing to copy. */
export function trajectoryCopyText(entry: AgentEntry): string | null {
  switch (entry.type) {
    case "user":
    case "agent":
    case "thought":
    case "message":
      return entry.text || null;
    case "tool":
      return [entry.title, entry.kind, entry.output ?? ""].filter(Boolean).join("\n") || null;
    case "plan":
      return entry.items.map((i) => i.content).join("\n") || null;
    case "subagent":
      return [entry.prompt ?? "", entry.reply ?? ""].filter(Boolean).join("\n\n") || null;
    case "permission":
      return entry.title || null;
    case "error":
      return entry.message || null;
  }
}
