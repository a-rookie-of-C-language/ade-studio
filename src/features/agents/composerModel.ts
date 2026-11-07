/** Pure composer helpers: `@` / `/` completion, attachments, history recall, settings. */
import type {
  AgentCommand,
  AgentConfigOption,
  AgentCost,
  AgentEntry,
  AgentImage,
  AgentLaunchReceipt,
  AgentLimit,
  AgentPrompt,
  AgentRetry,
  AgentUsage,
} from "@/bindings";
import { tx } from "@/platform/i18n";

export interface FileRef {
  /** Absolute path (in the task's directory). */
  path: string;
  /** As written after `@`. */
  rel: string;
}

export interface ComposerDraft {
  text: string;
  files: FileRef[];
  images: AgentImage[];
  /** Long pastes folded out of the text; `text` holds one token line per entry. */
  pastes: PastedText[];
}

export interface PastedText {
  id: string;
  /** The pasted content, verbatim. */
  text: string;
}

/** Fold pastes longer than this: a 200-line log should be a chip, a snippet stays inline. */
export const PASTE_FOLD_MIN_LINES = 8;
export const PASTE_FOLD_MIN_CHARS = 1200;

let pasteCounter = 0;

/** Whether pasted text belongs in a folded chip instead of the textarea. */
export function shouldFoldPasted(text: string): boolean {
  if (!text.trim()) return false;
  return text.split("\n").length > PASTE_FOLD_MIN_LINES || text.length > PASTE_FOLD_MIN_CHARS;
}

const pasteLineCount = (text: string) => text.split("\n").length;

/** A folded paste and the token line standing in for it: `[Pasted 47 lines #a1b2]`. */
export function foldPasted(text: string): { paste: PastedText; token: string } {
  const id = `${Date.now().toString(36)}${(pasteCounter++).toString(36)}`;
  const paste = { id, text };
  return { paste, token: pasteToken(id, pasteLineCount(text)) };
}

const pasteToken = (id: string, lines: number) => `[Pasted ${lines} line${lines === 1 ? "" : "s"} #${id}]`;

const PASTE_TOKEN_PATTERN = /\[Pasted \d+ lines? #([a-z0-9]+)\]/g;

/** Paste ids still tokenized in the text, in order. */
export function pastedIds(text: string): string[] {
  return [...text.matchAll(PASTE_TOKEN_PATTERN)].map((m) => m[1]!);
}

/** Pastes still tokenized in the text: what the agent will receive, in token order. */
export function effectivePastes(draft: ComposerDraft): PastedText[] {
  const byId = new Map(draft.pastes.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: PastedText[] = [];
  for (const id of pastedIds(draft.text)) {
    const paste = byId.get(id);
    if (paste && !seen.has(id)) {
      seen.add(id);
      out.push(paste);
    }
  }
  return out;
}

const PASTE_TOKEN_LINE = /^\[Pasted \d+ lines? #([a-z0-9]+)\]$/;

/** Replaces token lines with the pasted content; unknown tokens stay visible, never silently lost. */
export function expandPastes(draft: ComposerDraft): string {
  const byId = new Map(draft.pastes.map((p) => [p.id, p.text]));
  return draft.text
    .split("\n")
    .map((line) => {
      const m = PASTE_TOKEN_LINE.exec(line.trim());
      return m && byId.has(m[1]!) ? byId.get(m[1]!)! : line;
    })
    .join("\n");
}

/** Drops the paste's token line from the text and tidies the gap. */
export function removePasteToken(text: string, id: string): string {
  // Tokens always stand on their own line; a mid-line remnant is user text and stays.
  const single = new RegExp(`^\\[Pasted \\d+ lines? #${id}\\]$`);
  return text
    .split("\n")
    .filter((line) => !single.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export type Completion =
  | { kind: "file"; query: string; from: number; to: number }
  | { kind: "command"; query: string; from: number; to: number };

/** The `@file` or leading `/command` being typed at `caret`, if any. */
export function completionAt(text: string, caret: number): Completion | null {
  const before = text.slice(0, caret);
  const word = /(^|\s)([@/])([^\s@]*)$/.exec(before);
  if (!word) return null;
  const from = caret - word[3]!.length - 1;
  // Commands only as the message's first word.
  if (word[2] === "/")
    return before.slice(0, from).trim() === "" ? { kind: "command", query: word[3]!, from, to: caret } : null;
  return { kind: "file", query: word[3]!, from, to: caret };
}

/** Replaces the completion with `insert` plus a space; returns the text and the caret after it. */
export function applyCompletion(text: string, c: Completion, insert: string): { text: string; caret: number } {
  const after = text.slice(c.to);
  const glue = after.startsWith(" ") ? "" : " ";
  const next = text.slice(0, c.from) + insert + glue + after;
  return { text: next, caret: c.from + insert.length + 1 };
}

/**
 * Commands matching `query`: prefix matches first (a plugin's "plugin:name" also by its
 * name), then substrings, then names holding its letters in order ("trig" → "triage").
 */
export function matchCommands(commands: readonly AgentCommand[], query: string): AgentCommand[] {
  const q = query.toLowerCase();
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q) || n.slice(n.lastIndexOf(":") + 1).startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    return inOrder(n, q) ? 2 : -1;
  };
  return commands
    .map((command) => ({ command, rank: rank(command.name) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((m) => m.command);
}

function inOrder(text: string, query: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i >= query.length;
}

/** Whether an `@` query is a typed-out path (`../x`, `./x`, `/x`) rather than a project file search. */
export const isPathQuery = (query: string) => /^(\.\.?(\/|$)|\/)/.test(query);

const isDrive = (part: string | undefined) => !!part && /^[A-Za-z]:$/.test(part);

/** `rel` (as typed after `@`) resolved against `root`, `.` and `..` folded lexically. */
export function resolveTyped(root: string, rel: string): string {
  const out: string[] = [];
  const path = rel.startsWith("/") ? rel : `${root.replace(/\\/g, "/")}/${rel}`;
  for (const part of path.split("/")) {
    if (part === "..") {
      // Never fold away a Windows drive (`C:`).
      if (out.length > 1 || !isDrive(out[0])) out.pop();
    } else if (part && part !== ".") out.push(part);
  }
  return isDrive(out[0]) ? out.join("/") : `/${out.join("/")}`;
}

interface IndexMatch {
  path: string;
  relPath: string;
  score: number;
}

/**
 * Index file and folder matches as one list, best first (files first on a tie); folders'
 * `rel` loses the trailing `/` the index gives them.
 */
export function mergeMatches(
  files: readonly IndexMatch[],
  dirs: readonly IndexMatch[],
  limit: number,
): { path: string; rel: string; dir: boolean; score: number }[] {
  return [
    ...files.map((f) => ({ path: f.path, rel: f.relPath, dir: false, score: f.score })),
    ...dirs.map((d) => ({ path: d.path, rel: d.relPath.replace(/\/$/, ""), dir: true, score: d.score })),
  ]
    .sort((a, b) => b.score - a.score || Number(a.dir) - Number(b.dir))
    .slice(0, limit);
}

/** `@rel` with a line range suffix when given ("@src/a.rs:10-20"). */
export function mentionOf(rel: string, lines?: { from: number; to: number }): string {
  if (!lines) return `@${rel}`;
  return lines.from === lines.to ? `@${rel}:${lines.from}` : `@${rel}:${lines.from}-${lines.to}`;
}

/** A mention of `rel` with any `:lines` suffix: what keeps a file referenced. */
function mentionPattern(rel: string): RegExp {
  return new RegExp(`@${escapeRe(rel)}(?![\\w./-])|@${escapeRe(rel)}:`);
}

/** Files still mentioned in the text (each once): what the agent will receive. */
export function effectiveFiles(draft: ComposerDraft): FileRef[] {
  const seen = new Set<string>();
  return draft.files.filter((f) => {
    if (seen.has(f.path) || !mentionPattern(f.rel).test(draft.text)) return false;
    seen.add(f.path);
    return true;
  });
}

/** Drops every `@rel` (with any `:lines` suffix) from the text and tidies the gap. */
export function removeMention(text: string, rel: string): string {
  // The trailing guard mirrors the mention pattern: `@a.ts` never eats `@a.tsx`.
  return text
    .replace(new RegExp(`@${escapeRe(rel)}(?::\\d*(?:-\\d+)?)?(?![\\w./-])`, "g"), "")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The prompt to send: files still mentioned in the text (each once), pastes expanded, and the images. */
export function toPrompt(draft: ComposerDraft): AgentPrompt {
  const files = effectiveFiles(draft);
  return { text: expandPastes(draft).trim(), files: files.map((f) => f.path), images: draft.images };
}

export const canSend = (d: ComposerDraft) => !!d.text.trim() || d.images.length > 0;

/**
 * ↑ / ↓ through sent messages (newest first). `index` −1 is the unsent draft. Returns the
 * new index, or `null` when the key should move the caret instead.
 */
export function recall(history: readonly string[], index: number, dir: -1 | 1): number | null {
  const next = index + (dir < 0 ? 1 : -1);
  if (next < -1 || next >= history.length) return null;
  return next;
}

/** Whether ↑ / ↓ recalls history: the caret is on the first / last line. */
export function atEdgeLine(text: string, caret: number, dir: -1 | 1): boolean {
  return dir < 0 ? !text.slice(0, caret).includes("\n") : !text.slice(caret).includes("\n");
}

/** The settings shown in the composer: model, mode, permissions, approvals, effort. */
export function mainOptions(config: readonly AgentConfigOption[]): AgentConfigOption[] {
  const order = ["model", "mode", "permissions", "approval", "thought_level"];
  return order.flatMap((c) => config.filter((o) => o.category === c).slice(0, 1));
}

export const modeOption = (config: readonly AgentConfigOption[]) => config.find((o) => o.category === "mode");

/**
 * An icon per permission mode, by what it lets the agent do (mode ids differ per agent:
 * Claude `acceptEdits`, Gemini `auto_edit`, Codex `full-access`…). Unknown modes ask.
 */
export function modeIcon(mode: string): string {
  const m =
    mode
      .toLowerCase()
      .split(/[#/]/)
      .at(-1)
      ?.replace(/[^a-z]/g, "") ?? "";
  if (m.includes("plan") || m === "architect") return "todo";
  if (m.includes("bypass") || m === "yolo" || m.includes("fullaccess") || m === "dangerous") return "unlock";
  if (m.includes("readonly") || m === "ask" || m === "chat") return "eye";
  if (m.includes("edit") || m === "code") return "edit";
  if (m === "auto" || m === "agent" || m.includes("autopilot")) return "run";
  return "lock";
}

/** The settings that approve everything without asking (a bypass mode, or approvals), by option id. */
export function bypassDefaults(config: readonly AgentConfigOption[]): Record<string, string> {
  const out: Record<string, string> = {};
  const mode = modeOption(config);
  const unlock = mode?.values.find((v) => modeIcon(v.value) === "unlock");
  if (mode && unlock) out[mode.id] = unlock.value;
  const permissions = config.find((o) => o.category === "permissions");
  const allowAll = permissions?.values.find((v) => /^(on|true)$/i.test(v.value));
  if (permissions && allowAll) out[permissions.id] = allowAll.value;
  const approval = config.find((o) => o.category === "approval");
  if (approval?.values.some((v) => v.value === "bypass")) out[approval.id] = "bypass";
  return out;
}

/** Shift+Tab: the mode after the current one. */
export function nextValue(option: AgentConfigOption, current = option.current): string | null {
  if (!option.values.length) return null;
  const i = option.values.findIndex((v) => v.value === current);
  return option.values[(i + 1) % option.values.length]!.value;
}

/** "12%" of the context window and a tooltip with the numbers. */
/** A pending API retry: "3/10" (or "3" when the agent gives no limit) and the seconds left. */
export function retryParts(r: AgentRetry, now: number): { attempt: string; wait: number } {
  return {
    attempt: r.maxRetries != null ? `${r.attempt}/${r.maxRetries}` : String(r.attempt),
    wait: r.retryAtMs == null ? 0 : Math.max(0, Math.ceil((r.retryAtMs - now) / 1000)),
  };
}

export function usageLabel(u: AgentUsage): { short: string; detail: string } {
  const pct = Math.min(100, Math.round((u.used / u.size) * 100));
  // Estimates wear a `~`: they are summed from message-level token counts, not
  // the provider's own report. Absent entirely means unknown (nothing reported
  // yet, or the last reading was invalidated by a compaction or model change).
  const short = u.kind === "estimate" ? `~${pct}%` : `${pct}%`;
  const lines = [tx`${tokens(u.used)} / ${tokens(u.size)} tokens`];
  if (u.model) lines.push(tx`Model ${u.model}`);
  if (u.kind === "estimate") lines.push(tx`Estimated from the last response`);
  for (const c of u.categories ?? []) lines.push(tx`${c.name}: ${tokens(c.tokens)} tokens`);
  return { short, detail: lines.join("\n") };
}

/** `850`, `83.1k`, `1M`: the token counts shown in the context breakdown. */
export function formatTokens(n: number): string {
  return tokens(n);
}

/**
 * The launch environment card: what the backend reports about how the task was
 * started (agent, binary, surface), and nothing it doesn't. A missing receipt
 * (tasks saved before this was tracked) reads as unknown, never as a guess.
 */
export function launchLabel(
  launch: AgentLaunchReceipt | null | undefined,
  providerName: string,
): { short: string; detail: string } {
  if (!launch) return { short: providerName, detail: tx`How this task was launched was not reported` };
  const surface = launch.surface === "terminal" ? tx`terminal` : tx`chat`;
  const lines = [tx`Runs in ${surface}`, [launch.program, ...(launch.args ?? [])].join(" ")];
  if (!launch.installed) lines.push(tx`Not installed`);
  if (launch.fallback) lines.push(tx`Fell back: ${launch.fallback.reason}`);
  return { short: `${providerName} · ${surface}`, detail: lines.join("\n") };
}

/** The usage-limit windows agents report, by the name they give them; others show that name. */
const LIMIT_WINDOWS: Record<string, { short: string; name: string }> = {
  five_hour: { short: "5h", name: "5-hour limit" },
  seven_day: { short: "7d", name: "Weekly limit" },
  seven_day_opus: { short: "7d Opus", name: "Weekly Opus limit" },
  seven_day_sonnet: { short: "7d Sonnet", name: "Weekly Sonnet limit" },
};

/** "5h 19%" for a usage-limit window, and a tooltip saying when it resets. */
export function limitLabel(l: AgentLimit, now: number): { short: string; percent: number; detail: string } {
  const known = LIMIT_WINDOWS[l.window];
  const percent = Math.min(100, Math.round(l.usedPercent ?? 0));
  const name = known ? tx(known.name) : l.window;
  const used = tx`${name}: ${percent}% used`;
  if (l.resetsMs == null) return { short: `${known?.short ?? l.window} ${percent}%`, percent, detail: used };
  const reset = untilReset(Math.max(0, l.resetsMs - now));
  return { short: `${known?.short ?? l.window} ${percent}%`, percent, detail: tx`${used}, resets in ${reset}` };
}

/** `45m`, `2h 51m`, `5d 3h`. */
function untilReset(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "$0.42": what the session has cost so far. */
export function costLabel(c: AgentCost): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c.currency }).format(c.amount ?? 0);
  } catch {
    // Not an ISO 4217 code.
    return `${(c.amount ?? 0).toFixed(2)} ${c.currency}`;
  }
}

/** `850`, `83.1k`, `1M`. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

/** Time the agent spent on the task's turns; a running one counts up to `now` (`null` when idle). */
export function workTime(entries: readonly AgentEntry[], now: number | null): number {
  const users = entries.filter((e): e is Extract<AgentEntry, { type: "user" }> => e.type === "user");
  let total = 0;
  users.forEach((e, i) => {
    if (e.sentMs == null) return;
    const end = e.doneMs ?? (i === users.length - 1 ? now : null);
    if (end != null && end > e.sentMs) total += end - e.sentMs;
  });
  return total;
}

/** `data:image/png;base64,AAA` → an image attachment. */
export function imageFromDataUrl(url: string, name?: string): AgentImage | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m || !m[1]!.startsWith("image/")) return null;
  return { mimeType: m[1]!, data: m[2]!, name: name ?? null };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
