/**
 * Solo Mode (View): the fullscreen builder. The left and bottom tool windows
 * hide, the chat stays on the right at a usable width, and the frame drops
 * its tabs, banners and status bar -- only a bare title bar remains above
 * the editor. The same action enters and exits; exiting restores the
 * remembered layout. Like Distraction Free Mode the mode is an
 * application-wide preference that survives restarts (localStorage, next to
 * the saved tool window layouts, which keep the layout to restore on exit).
 * Published as the `soloMode` context key; components read `useSoloMode`.
 *
 * TRAE mapping: this mirrors the in-IDE Solo (`soloMode()` / `ideMode()` in
 * the desktop workbench), which hides the sidebar and panel, keeps the AI
 * sidebar on the right, and animates the tracks between the two states.
 * TRAE's track animation runs ~750ms around overlay clones; openidea reuses
 * its own track transition (.3s `gridAnim`, like Agent Mode's switch) since
 * there is no VSCode gridview to choreograph here. The separate solo-lite
 * window (TRAE's lightweight bundle) is out of scope: this is the IDE-frame
 * Solo.
 *
 * Layering: this file must not import features (features import the
 * workbench, never the reverse). The Agents tool window is therefore kept
 * on the right by whoever is there; the agents feature subscribes to Solo
 * Mode and docks the conversation there on enter. Exiting never undocks:
 * like TRAE's IDE, the chat stays on the right.
 *
 * Mutual exclusion with Agent Mode is enforced from the agents side
 * (workbench cannot call into features): entering Agent Mode exits Solo,
 * and the agents feature exits Agent Mode when Solo activates.
 */
import { create } from "zustand";
import { registerAction, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { setDistractionFree, isDistractionFree } from "./distractionFree";
import { expireNotification, notify } from "./notificationStore";
import {
  enterSoloModeLayout,
  exitSoloModeLayout,
  setLayoutTransition,
  useToolWindowLayout,
  type SlotRecord,
} from "./toolwindows/store";

export const SOLO_MODE_ACTION = "view.toggleSoloMode";
export const SOLO_MODE_CONTEXT = "soloMode";
/** Right-side width the mode guarantees for the chat. */
export const SOLO_MODE_RIGHT_WIDTH = 400;
/** Track animation length: TRAE's mode switch runs .3s; the flag clears just after. */
export const SOLO_MODE_TRANSITION_MS = 350;
const STORAGE_KEY = "openidea.soloMode";
export const SOLO_MODE_HINT_KEY = "soloMode.hint";

export const useSoloMode = create<{ active: boolean }>(() => ({ active: false }));

export function isSoloMode(): boolean {
  return useSoloMode.getState().active;
}

export function soloModeTitle(active: boolean): string {
  return active ? "Exit Solo Mode" : "Enter Solo Mode";
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

/** The solo layout for the current tool window state: left and bottom hidden, right kept. */
function soloLayout(): { visible: SlotRecord; rightSize: number } {
  const s = useToolWindowLayout.getState();
  const visible = { ...s.visible };
  visible.left = null;
  visible.bottom = null;
  visible["bottom-split"] = null;
  return { visible, rightSize: Math.max(s.sizes.right, SOLO_MODE_RIGHT_WIDTH) };
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
    if (isSoloMode()) setLayoutTransition(false);
  }, SOLO_MODE_TRANSITION_MS);
}

function endTransition() {
  clearTransitionTimer();
  setLayoutTransition(false);
}

function showHint() {
  if (!hintPending || !isSoloMode() || !useToolWindowLayout.getState().scope) return;
  hintPending = false;
  notify({
    key: SOLO_MODE_HINT_KEY,
    // Its own group: the balloon's "Don't Show Again" turns off this hint only (Settings › Notifications).
    group: "soloMode",
    level: "info",
    title: "Solo Mode",
    body: soloModeHint(),
    actions: [{ label: "Exit Solo Mode", run: () => setSoloMode(false) }],
  });
}

export function soloModeHint(): string {
  const own = shortcutLabel(SOLO_MODE_ACTION);
  const find = shortcutLabel("navigate.findAction");
  const way = own ?? (find ? `Find Action (${find})` : "Find Action");
  return `To exit Solo Mode, use View | Exit Solo Mode or ${way}.`;
}

export function setSoloMode(active: boolean) {
  if (active === isSoloMode()) return;
  // Mutually exclusive with Distraction Free Mode: leaving it restores the layout to stash.
  if (active && isDistractionFree()) setDistractionFree(false);
  useSoloMode.setState({ active });
  setContext(SOLO_MODE_CONTEXT, active);
  writeStored(active);
  hintPending = active;
  if (active) {
    // Read after publishing: the agents feature docks its conversation on
    // this transition, and the layout below keeps whatever is on the right.
    const { visible, rightSize } = soloLayout();
    enterSoloModeLayout(visible, rightSize);
    beginTransition();
  } else exitSoloModeLayout();
  if (active) showHint();
  else {
    endTransition();
    expireNotification(SOLO_MODE_HINT_KEY);
  }
}

export function toggleSoloMode() {
  setSoloMode(!isSoloMode());
}

function action(active: boolean): Action {
  return {
    id: SOLO_MODE_ACTION,
    title: soloModeTitle(active),
    category: "View",
    keywords: ["solo mode", "toggle solo mode", "fullscreen builder"],
    run: toggleSoloMode,
  };
}

/**
 * Registers the action (its title follows the mode), restores the saved mode
 * and re-applies the solo layout when a project's layout loads.
 */
export function installSoloMode(): () => void {
  let dispose = registerAction(action(isSoloMode()));
  const unsubMode = useSoloMode.subscribe((s, prev) => {
    if (s.active === prev.active) return;
    const previous = dispose;
    dispose = registerAction(action(s.active));
    previous();
  });
  const unsubLayout = useToolWindowLayout.subscribe((s, prev) => {
    if (s.scope === prev.scope || !isSoloMode()) return;
    const { visible, rightSize } = soloLayout();
    enterSoloModeLayout(visible, rightSize);
    showHint();
  });
  setContext(SOLO_MODE_CONTEXT, isSoloMode());
  if (readStored()) setSoloMode(true);
  return () => {
    clearTransitionTimer();
    unsubMode();
    unsubLayout();
    dispose();
  };
}

/** Test helper. */
export function resetSoloMode() {
  hintPending = false;
  clearTransitionTimer();
  useSoloMode.setState({ active: false });
  setContext(SOLO_MODE_CONTEXT, false);
  writeStored(false);
}
