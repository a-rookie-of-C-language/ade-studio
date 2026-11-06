/**
 * Agent Mode (View): the project frame keeps the left side, the bottom is
 * hidden and the Agents tool window is pinned on the right at a usable width
 * and focused. The same action enters and exits; exiting restores the
 * remembered tool window layout (sizes/visibility), but the conversation
 * stays docked on the right the way TRAE's IDE does -- there is no centered
 * editor-tab chat in the IDE frame. Like Distraction Free Mode the mode is
 * an application-wide preference that survives restarts (localStorage, next
 * to the saved tool window layouts, which keep the layout to restore on
 * exit). Published as the `agentMode` context key; components read
 * `useAgentMode`. Entering the mode exits Distraction Free Mode first; the
 * reverse nests (Distraction Free entered atop Agent Mode restores the agent
 * layout). Conversations follow TRAE: entering docks them in the Agents
 * tool window on the right, exiting keeps them there.
 */
import { create } from "zustand";
import { registerAction, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { setDistractionFree } from "@/workbench/distractionFree";
import { expireNotification, notify } from "@/workbench/notificationStore";
import {
  enterAgentModeLayout,
  exitAgentModeLayout,
  setLayoutTransition,
  showToolWindow,
  slotOfId,
  useToolWindowLayout,
  type SlotRecord,
} from "@/workbench/toolwindows/store";
import { TOOL_WINDOW } from "./model";
import { carrySessionToDocked, setSessionLocation, useAgents, type SessionLocation } from "./store";

export const AGENT_MODE_ACTION = "agents.toggleAgentMode";
export const AGENT_MODE_CONTEXT = "agentMode";
/** Right-side width the mode guarantees for the Agents tool window. */
export const AGENT_MODE_RIGHT_WIDTH = 360;
/** Track animation length: TRAE's mode switch runs .3s; the flag clears just after. */
export const AGENT_MODE_TRANSITION_MS = 350;
const STORAGE_KEY = "openidea.agentMode";
const LOCATION_STASH_KEY = "openidea.agentMode.sessionLocation";
export const AGENT_MODE_HINT_KEY = "agentMode.hint";

export const useAgentMode = create<{ active: boolean }>(() => ({ active: false }));

export function isAgentMode(): boolean {
  return useAgentMode.getState().active;
}

export function agentModeTitle(active: boolean): string {
  return active ? "Exit Agent Mode" : "Enter Agent Mode";
}

function writeStored(active: boolean) {
  try {
    if (active) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Placement from before the mode; kept while a mid-mode undock stays respected. */
let stashedLocation: SessionLocation | null = null;

function readStashedLocation(): SessionLocation | null {
  if (stashedLocation) return stashedLocation;
  try {
    const saved = localStorage.getItem(LOCATION_STASH_KEY);
    return saved === "editor" || saved === "toolWindow" ? saved : null;
  } catch {
    return null;
  }
}

/** Remember the placement once (restart-safe: the stored one wins) and dock right. */
function dockConversation() {
  if (!readStashedLocation()) {
    const current = useAgents.getState().sessionLocation;
    stashedLocation = current;
    try {
      localStorage.setItem(LOCATION_STASH_KEY, current);
    } catch {
      /* storage unavailable */
    }
  }
  if (useAgents.getState().sessionLocation !== "toolWindow") setSessionLocation("toolWindow");
  // Already docked on the right: the shell may still center an undocked
  // fallback (last/newest task), which the IDE would otherwise drop on exit.
  carrySessionToDocked();
}

function restoreConversation() {
  // TRAE's IDE always shows the chat on the right, so leaving Agent Mode
  // keeps the conversation docked instead of restoring a centered editor
  // tab. The stash is only cleared; an explicit editor placement the user
  // picks afterwards still wins via setSessionLocation.
  stashedLocation = null;
  try {
    localStorage.removeItem(LOCATION_STASH_KEY);
  } catch {
    /* storage unavailable */
  }
  if (useAgents.getState().sessionLocation !== "toolWindow") setSessionLocation("toolWindow");
  // Every exit path (shell button, menu, shortcut) keeps the centered session.
  carrySessionToDocked();
}

export function agentModeHint(): string {
  const own = shortcutLabel(AGENT_MODE_ACTION);
  const find = shortcutLabel("navigate.findAction");
  const way = own ?? (find ? `Find Action (${find})` : "Find Action");
  return `To exit Agent Mode, use View | Exit Agent Mode or ${way}.`;
}

/** The agent layout for the current tool window state: bottom hidden, Agents pinned right. */
function agentLayout(): { visible: SlotRecord; rightSize: number } {
  const s = useToolWindowLayout.getState();
  const visible = { ...s.visible };
  visible.bottom = null;
  visible["bottom-split"] = null;
  visible[slotOfId(TOOL_WINDOW) ?? "right"] = TOOL_WINDOW;
  return { visible, rightSize: Math.max(s.sizes.right, AGENT_MODE_RIGHT_WIDTH) };
}

/** Set on entering the mode; the hint shows once a project frame is there to leave. */
let hintPending = false;

let transitionTimer: ReturnType<typeof setTimeout> | null = null;

function clearTransitionTimer() {
  if (transitionTimer !== null) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }
}

/** Entering animates the tracks (like TRAE's mode switch); exiting restores instantly. */
function beginTransition() {
  clearTransitionTimer();
  setLayoutTransition(true);
  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    if (isAgentMode()) setLayoutTransition(false);
  }, AGENT_MODE_TRANSITION_MS);
}

function endTransition() {
  clearTransitionTimer();
  setLayoutTransition(false);
}

function showHint() {
  if (!hintPending || !isAgentMode() || !useToolWindowLayout.getState().scope) return;
  hintPending = false;
  notify({
    key: AGENT_MODE_HINT_KEY,
    // Its own group: the balloon's "Don't Show Again" turns off this hint only (Settings › Notifications).
    group: "agentMode",
    level: "info",
    title: "Agent Mode",
    body: agentModeHint(),
    actions: [{ label: "Exit Agent Mode", run: () => setAgentMode(false) }],
  });
}

export function setAgentMode(active: boolean) {
  if (active === isAgentMode()) return;
  // Mutually exclusive with Distraction Free Mode: leaving it restores the layout to stash.
  if (active) setDistractionFree(false);
  useAgentMode.setState({ active });
  setContext(AGENT_MODE_CONTEXT, active);
  writeStored(active);
  hintPending = active;
  if (active) {
    const { visible, rightSize } = agentLayout();
    enterAgentModeLayout(visible, rightSize);
    dockConversation();
    showToolWindow(TOOL_WINDOW, true);
    beginTransition();
  } else exitAgentModeLayout();
  if (active) showHint();
  else {
    endTransition();
    restoreConversation();
    expireNotification(AGENT_MODE_HINT_KEY);
  }
}

export function toggleAgentMode() {
  setAgentMode(!isAgentMode());
}

function action(active: boolean): Action {
  return {
    id: AGENT_MODE_ACTION,
    title: agentModeTitle(active),
    category: "View",
    keywords: ["agent mode", "toggle agent mode", "focus agents"],
    run: toggleAgentMode,
  };
}

/**
 * Registers the action (its title follows the mode), restores the saved mode
 * and re-applies the agent tool window layout when a project's layout loads.
 */
export function installAgentMode(): () => void {
  let dispose = registerAction(action(isAgentMode()));
  const unsubMode = useAgentMode.subscribe((s, prev) => {
    if (s.active === prev.active) return;
    const previous = dispose;
    dispose = registerAction(action(s.active));
    previous();
  });
  const unsubLayout = useToolWindowLayout.subscribe((s, prev) => {
    if (s.scope === prev.scope || !isAgentMode()) return;
    const { visible, rightSize } = agentLayout();
    enterAgentModeLayout(visible, rightSize);
    showHint();
  });
  setContext(AGENT_MODE_CONTEXT, isAgentMode());
  if (readStored()) setAgentMode(true);
  return () => {
    clearTransitionTimer();
    unsubMode();
    unsubLayout();
    dispose();
  };
}

/** Test helper. */
export function resetAgentMode() {
  hintPending = false;
  clearTransitionTimer();
  stashedLocation = null;
  useAgentMode.setState({ active: false });
  setContext(AGENT_MODE_CONTEXT, false);
  writeStored(false);
  try {
    localStorage.removeItem(LOCATION_STASH_KEY);
  } catch {
    /* storage unavailable */
  }
}
