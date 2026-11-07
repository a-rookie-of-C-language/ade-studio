/** Agent tasks of the open project, mirrored from `ide-agent` through `agentSubscribe`. */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  AgentChange,
  AgentEntry,
  AgentEvent,
  ExternalSession,
  AgentLimit,
  AgentProvider,
  AgentTask,
  Isolation,
} from "@/bindings";
import { useProject } from "@/platform/project";
import { call, commands, isTauri } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { editorService, notifications, toolWindowService } from "@/workbench/contributions";
import type { ComposerDraft } from "./composerModel";
import type { ModelFavorite, ModelRecent } from "./modelFavorites";
import { SESSION_KIND, TOOL_WINDOW, attentionChange, entriesKey, isBusy, sessionKey, upsertEntry } from "./model";

/** New Task page settings (its text lives in the `HOME` composer). */
export interface Draft {
  projectRoot?: string | null;
  provider: string;
  /** Settings chosen for the next task, by option id (reset when the agent changes). */
  config: Record<string, string>;
  isolation: Isolation;
  /** The user picked `isolation`: otherwise a task runs in the local checkout. */
  isolationChosen?: boolean;
  /** `null`: the current branch. */
  base: string | null;
}

/** Composer key of the New Task page; sessions use their task id. */
export const HOME = "home";

export type SessionLocation = "editor" | "toolWindow";

interface AgentsState {
  loaded: boolean;
  /** Why the tasks could not be loaded. */
  error: string | null;
  tasks: Map<string, AgentTask>;
  /** Tasks with unseen replies or status changes in this project. */
  unread: Set<string>;
  /** Entries of the tasks (and subagents) opened in this window, by `entriesKey`. */
  entries: Map<string, AgentEntry[]>;
  changes: Map<string, AgentChange[]>;
  /** Scroll position and follow-output preference by conversation, shared by both hosts. */
  scrollPositions: Map<string, { top: number; stick: boolean }>;
  providers: AgentProvider[];
  /** The usage limits each agent last reported for its account, by provider. */
  limits: Map<string, AgentLimit[]>;
  draft: Draft;
  composers: Map<string, ComposerDraft>;
  /** The composer typed in last: where "Send to Agent" adds references. */
  lastComposer: string;
  /** First messages of past tasks, newest first (New Task page ↑). */
  history: string[];
  /** Starred model+effort configs, by agent provider. */
  modelFavorites: ModelFavorite[];
  /** Recently used model+effort configs, newest first, by agent provider. */
  modelRecents: ModelRecent[];
  /** The composer asked to take focus (`seq` tells repeated requests apart). */
  focus: { key: string; seq: number } | null;
  /** Task shown inside the Agents tool window instead of an editor tab. */
  docked: string | null;
  sessionLocation: SessionLocation;
  lastTask: string | null;
  homeOpen: boolean;
  /** Task shown inline in the Cowork home when no project is open (Welcome has no editor tabs). */
  coworkTask: string | null;
  /** Pinned task ids, newest first; shown atop the Cowork sidebar across projects. */
  pinned: string[];
  /** Sessions created outside OpenIDEA (another Codex or Claude client), newest first. */
  external: ExternalSession[];
  /** Why the external sessions could not be loaded. */
  externalError: string | null;
}

const DRAFT_KEY = "openidea.agents.draft.v2";
const HISTORY_KEY = "openidea.agents.history.v1";

const PINNED_KEY = "{{SECRET_kb06lsdf}}";
const FAVORITES_KEY = "{{SECRET_xks9nk53}}";
const RECENTS_KEY = "{{SECRET_669ln141}}";

function load<T>(key: string, fallback: T): T {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null") as T | null;
    return saved ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const fallbackDraft: Draft = { provider: "claude", config: {}, isolation: "local", base: null };

/**
 * The saved New Task settings. A worktree is used only when the user picked it: drafts
 * saved before that choice was recorded carried the old default (`worktree`) instead.
 */
export function savedDraft(saved: Partial<Draft>): Draft {
  const draft = { ...fallbackDraft, ...saved };
  return draft.isolationChosen ? draft : { ...draft, isolation: "local" };
}

export const useAgents = create<AgentsState>(() => ({
  loaded: false,
  error: null,
  tasks: new Map(),
  unread: new Set(),
  entries: new Map(),
  changes: new Map(),
  providers: [],
  limits: new Map(),
  draft: savedDraft(load<Partial<Draft>>(DRAFT_KEY, {})),
  composers: new Map(),
  lastComposer: HOME,
  history: load<string[]>(HISTORY_KEY, []),
  modelFavorites: load<ModelFavorite[]>(FAVORITES_KEY, []),
  modelRecents: load<ModelRecent[]>(RECENTS_KEY, []),
  focus: null,
  docked: null,
  // TRAE's IDE keeps the chat on the right: default to the tool window, not
  // a centered editor tab. Only an explicit "editor" choice opts into center.
  // The tool window is gone: every session opens in the editor (or the
  // Cowork column). Legacy `toolWindow` values on disk are ignored.
  sessionLocation: "editor",
  lastTask: null,
  homeOpen: false,
  coworkTask: null,
  pinned: load<string[]>(PINNED_KEY, []),
  scrollPositions: new Map(),
  external: [],
  externalError: null,
}));

/** Whether the task is pinned atop the Cowork sidebar. */
export function isPinned(id: string): boolean {
  return useAgents.getState().pinned.includes(id);
}

/** Pins or unpins the task atop the Cowork sidebar (survives restarts). */
export function togglePin(id: string) {
  const pinned = useAgents.getState().pinned.filter((p) => p !== id);
  if (!isPinned(id)) pinned.unshift(id);
  useAgents.setState({ pinned });
  save(PINNED_KEY, pinned);
}

/** Session tabs on screen; a task can be shown in more than one split. */
const visible = new Map<string, number>();
const windowFocused = () => document.visibilityState !== "hidden" && document.hasFocus();
const viewing = (task: string) => visible.has(task) && windowFocused();

function setUnread(task: string, value: boolean) {
  const s = useAgents.getState();
  if (s.unread.has(task) === value) return;
  const unread = new Set(s.unread);
  if (value) unread.add(task);
  else unread.delete(task);
  useAgents.setState({ unread });
}

function markUnread(task: string) {
  const current = useAgents.getState().tasks.get(task);
  if (current && current.status !== "archived" && !viewing(task)) setUnread(task, true);
}

let generation = 0;

/** Subscribes this window to the project's agents (again after the project changed). */
export async function connect(): Promise<void> {
  if (!isTauri()) return;
  const gen = ++generation;
  const channel = new Channel<AgentEvent>();
  channel.onmessage = (e) => {
    if (gen === generation) onEvent(e);
  };
  let tasks: AgentTask[], providers: AgentProvider[];
  try {
    [tasks, providers] = await Promise.all([
      call(commands.agentSubscribe(channel)),
      useProject.getState().project?.trusted === false
        ? Promise.resolve([] as AgentProvider[])
        : call(commands.agentProviders()),
    ]);
  } catch (e) {
    if (gen === generation) useAgents.setState({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (gen !== generation) return;
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    entries: new Map(),
    changes: new Map(),
    providers,
  });
  // A Cowork ⇄ IDE switch armed by `openCoworkSessionInIDE` / `backToCowork`
  // lands here: the new project is subscribed, so the carried session moves
  // into its store before stale tabs are closed (otherwise the carried tab
  // would look unknown and be closed again right after adopting).
  await consumePendingCarry();
  void refreshExternal();
  // Restored tabs of tasks deleted meanwhile close, like editors of deleted files.
  const editors = editorService();
  for (const t of editors.openTabs?.() ?? []) {
    const task = (t.input.data as { task?: string } | undefined)?.task;
    if (t.input.kind === SESSION_KIND && task && !useAgents.getState().tasks.has(task))
      await editors.closeInput?.(t.input.key);
  }
}

export function disconnect() {
  generation++;
  useAgents.setState({
    loaded: false,
    error: null,
    tasks: new Map(),
    unread: new Set(),
    entries: new Map(),
    changes: new Map(),
    docked: null,
    lastTask: null,
    homeOpen: false,
    coworkTask: null,
    scrollPositions: new Map(),
    external: [],
    externalError: null,
  });
}

/** Lists sessions created outside OpenIDEA (another Codex or Claude client). */
export async function refreshExternal(provider?: string): Promise<void> {
  if (!isTauri()) return;
  const gen = generation;
  try {
    const sessions = await call(commands.agentExternalSessions(provider ?? null));
    if (gen === generation) useAgents.setState({ external: sessions, externalError: null });
  } catch (e) {
    if (gen === generation) useAgents.setState({ externalError: e instanceof Error ? e.message : String(e) });
  }
}

function onEvent(e: AgentEvent) {
  const s = useAgents.getState();
  switch (e.type) {
    case "task": {
      const prev = s.tasks.get(e.task.id);
      useAgents.setState({ tasks: new Map(s.tasks).set(e.task.id, e.task) });
      if (e.task.status === "archived") setUnread(e.task.id, false);
      else if (attentionChange(prev?.status, e.task.status)) markUnread(e.task.id);
      notifyChange(prev, e.task);
      if (prev?.status !== e.task.status && !isBusy(e.task.status)) {
        void refreshChanges(e.task.id);
        void refreshProviders();
      }
      break;
    }
    case "removed": {
      const tasks = new Map(s.tasks);
      tasks.delete(e.id);
      const composers = new Map(s.composers);
      composers.delete(e.id);
      const unread = new Set(s.unread);
      unread.delete(e.id);
      useAgents.setState({
        tasks,
        composers,
        unread,
        ...(s.docked === e.id ? { docked: null } : {}),
        ...(s.coworkTask === e.id ? { coworkTask: null } : {}),
      });
      void editorService().closeInput?.(sessionKey(e.id));
      break;
    }
    case "truncated": {
      const current = s.entries.get(e.task);
      if (current) useAgents.setState({ entries: new Map(s.entries).set(e.task, current.slice(0, e.length)) });
      scheduleChanges(e.task);
      break;
    }
    case "providers": {
      void refreshProviders();
      break;
    }
    case "limits": {
      useAgents.setState({ limits: new Map(s.limits).set(e.provider, e.limits) });
      break;
    }
    case "entry": {
      if (
        !e.subagent &&
        ((e.entry.type === "agent" && e.entry.text.trim()) ||
          e.entry.type === "error" ||
          (e.entry.type === "permission" && e.entry.chosen === null))
      ) {
        markUnread(e.task);
      }
      const key = entriesKey(e.task, e.subagent);
      const current = s.entries.get(key);
      if (!current) return;
      const next = upsertEntry(current, e.index, e.entry);
      if (next) useAgents.setState({ entries: new Map(s.entries).set(key, next) });
      else void loadEntries(e.task, e.subagent);
      if (e.entry.type === "tool" && e.entry.status === "completed" && e.entry.diffs.length) {
        scheduleChanges(e.task);
      }
      break;
    }
  }
}

function notifyChange(prev: AgentTask | undefined, task: AgentTask) {
  const change = attentionChange(prev?.status, task.status);
  if (!change) return;
  if (viewing(task.id)) return;
  const body =
    change === "input"
      ? "Waiting for your answer"
      : change === "failed"
        ? (task.error ?? "The agent stopped")
        : "Finished";
  notifications().notify({
    level: change === "failed" ? "error" : "info",
    title: task.title,
    body,
    key: `agent:${task.id}`,
    group: "tools",
    sticky: change !== "finished",
    actions: [{ label: change === "finished" ? "Review" : "Open", run: () => openTask(task.id) }],
  });
}

/** Loads the entries of the task's conversation, or of its subagent `subagent`'s. */
export async function loadEntries(task: string, subagent: string | null = null): Promise<void> {
  const entries = await call(commands.agentEntries(task, subagent));
  useAgents.setState((s) => ({ entries: new Map(s.entries).set(entriesKey(task, subagent), entries) }));
}

export async function refreshChanges(task: string): Promise<void> {
  try {
    const changes = await call(commands.agentChanges(task));
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, changes) }));
  } catch {
    // The worktree is gone or not a repository: nothing to list.
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, []) }));
  }
}

const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleChanges(task: string) {
  if (pendingChanges.has(task)) return;
  pendingChanges.set(
    task,
    setTimeout(() => {
      pendingChanges.delete(task);
      void refreshChanges(task);
    }, 500),
  );
}

/** Reloads the agent list (custom and registry agents are re-read). */
export async function refreshProviders() {
  const providers = await call(commands.agentProviders()).catch(() => null);
  if (providers) useAgents.setState({ providers });
}

/** Shows `task` inline in the Cowork home (`null` returns to the composer). */
export function openCoworkTask(task: string | null) {
  useAgents.setState({ coworkTask: task, lastTask: task, homeOpen: false, docked: null });
}

export function openTask(task: string) {
  // Welcome/Cowork has neither editor tabs nor tool windows: a docked
  // conversation would open nowhere and the click would look dead, so Cowork
  // always keeps the conversation in its center column.
  const { project, lightEdit } = useProject.getState();
  if (!project && !lightEdit) {
    openCoworkTask(task);
    return;
  }
  if (useAgents.getState().sessionLocation === "toolWindow") {
    showDockedTask(task);
    return;
  }
  useAgents.setState({ lastTask: task, homeOpen: false });
  openTaskInEditor(task);
}

/** The agent UI is gone (sessions live in Cindy's interface now): opening calls must not throw. */
function openEditorInput(input: { kind: string; key: string; data: unknown }) {
  try {
    void editorService()
      .openInput(input, { focus: true })
      .catch(() => {});
  } catch {
    /* no session UI to open into */
  }
}

function openTaskInEditor(task: string) {
  // The title rides along so a restored tab has it before the tasks load.
  const title = useAgents.getState().tasks.get(task)?.title;
  openEditorInput({ kind: SESSION_KIND, key: sessionKey(task), data: { task, title } });
}

function showDockedTask(task: string) {
  useAgents.setState({ docked: task, lastTask: task, homeOpen: false });
  try {
    toolWindowService().show(TOOL_WINDOW, true);
  } catch {
    /* no tool window to show */
  }
  void editorService().closeInput?.(sessionKey(task));
}

/**
 * The session the Agent Mode shell centers: the docked one, else the last
 * opened, else the newest task (`null` on the New Task page). The IDE tool
 * window only shows a session when it is docked, so both mode switches carry
 * this id over to keep the same session on screen.
 */
export function centeredTask(): string | null {
  const s = useAgents.getState();
  if (s.homeOpen) return null;
  if (s.docked && s.tasks.has(s.docked)) return s.docked;
  if (s.lastTask && s.tasks.has(s.lastTask)) return s.lastTask;
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const t of s.tasks.values()) {
    const ms = t.updatedMs ?? 0;
    if (ms > newestMs) {
      newestMs = ms;
      newest = t.id;
    }
  }
  return newest;
}

/** A session carried across a Cowork home ⇄ IDE project switch in flight. */
interface PendingCarry {
  id: string;
  /** Where the session must be showing after the switch lands. */
  where: "ide" | "cowork";
  /** Project root the session is adopted from (`null`: the default workspace). */
  sourceRoot: string | null;
  /** IDE project root the switch must land on (`null`: back on the Cowork home). */
  targetRoot: string | null;
}

// Module-level on purpose: `disconnect()` clears the zustand state on every
// project switch, which is exactly when the carried session is homeless.
let pendingCarry: PendingCarry | null = null;

/**
 * Opens a Cowork session in the IDE, carrying it over: the IDE project loads a
 * different task store that never lists the Cowork session, so once the switch
 * lands the session is adopted into the new project and opened there.
 */
export function openCoworkSessionInIDE(id: string) {
  const task = useAgents.getState().tasks.get(id);
  if (!task) return;
  pendingCarry = { id, where: "ide", sourceRoot: null, targetRoot: task.cwd };
  void executeAction("welcome.openInIDE", task.cwd);
}

/**
 * Returns an IDE session to the Cowork home, carrying it over the same way: the
 * home lists the default workspace's store, so the session is adopted back there
 * once the project closes.
 */
export function backToCowork(id: string) {
  const root = useProject.getState().project?.root ?? null;
  pendingCarry = { id, where: "cowork", sourceRoot: root, targetRoot: null };
  void executeAction("file.closeProject");
}

/** Opens the carried session once the project switch it was waiting for lands. */
export async function consumePendingCarry(): Promise<void> {
  const carry = pendingCarry;
  if (!carry) return;
  const root = useProject.getState().project?.root ?? null;
  // A cancelled (or superseded) switch must never adopt into the wrong place.
  // Roots are compared slash-normalised: `task.cwd` may carry `\` separators
  // while the opened project reports `/` (Windows), which must still match.
  if (normRoot(root) !== normRoot(carry.targetRoot)) {
    pendingCarry = null;
    return;
  }
  pendingCarry = null;
  if (!useAgents.getState().tasks.has(carry.id)) {
    try {
      const adopted = await call(commands.agentAdoptTask(carry.id, carry.sourceRoot));
      useAgents.setState((s) => ({ tasks: new Map(s.tasks).set(adopted.id, adopted) }));
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Couldn't import the session",
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  }
  if (carry.where === "cowork") openCoworkTask(carry.id);
  else openTask(carry.id);
}

const normRoot = (p: string | null) => (p == null ? null : p.replace(/\\/g, "/").replace(/\/+$/, ""));

/** Moves the caret to the end of composer `key`. */
export function focusComposer(key: string) {
  useAgents.setState((s) => ({ focus: { key, seq: (s.focus?.seq ?? 0) + 1 } }));
}

/** Stops the task's turn, or with `subagent` only that subagent's work. */
