/**
 * Home-screen terminal: a drawer reusing the terminal runtime (PTY sessions,
 * tab strip) rooted at the agent workspace. Only the lazy loader is imported
 * here, so xterm.js stays out of the startup bundle until first use.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Icon, IconButton, Tabs, T, type TabItem } from "@/ui";
import { isTauri } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { loadTerminalRuntime, type TerminalRuntime } from "@/features/terminal/loader";
import { ensureHomeCwd, resolveHomeCwd } from "./workspace";
import styles from "./Cowork.module.css";

interface HomeTerminalState {
  open: boolean;
  /** Explicit cwd (e.g. a task's folder); null resolves the agent workspace. */
  cwd: string | null;
  setOpen: (open: boolean, cwd?: string | null) => void;
}

/** Drawer state shared by the home button and the session header's terminal action. */
export const useHomeTerminal = create<HomeTerminalState>((set) => ({
  open: false,
  cwd: null,
  setOpen: (open, cwd) => set((s) => ({ open, cwd: cwd === undefined ? (open ? s.cwd : null) : cwd })),
}));

/** Tests only. */
export function _resetHomeTerminalForTests() {
  useHomeTerminal.setState({ open: false, cwd: null });
}

/** Top-right button; hidden outside the desktop app (no PTY backend there). */
export function HomeTerminalButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  if (!isTauri()) return null;
  return <IconButton icon="terminal" title="Terminal" pressed={open} onClick={onToggle} />;
}

/** A session pane: attaches the store's xterm session, like the IDE's panes. */
function HomeTerminalPane({ rt, sessionKey }: { rt: TerminalRuntime; sessionKey: string }) {
  const { useTerminals, getSession } = rt;
  const ref = useRef<HTMLDivElement>(null);
  const dead = useTerminals((s) => {
    const status = s.sessions[sessionKey]?.status;
    return status === "exited" || status === "error";
  });
  useLayoutEffect(() => {
    const el = ref.current;
    const session = getSession(sessionKey);
    if (!el || !session) return;
    session.attach(el);
    return () => session.detach(el);
  }, [getSession, sessionKey]);
  return <div ref={ref} className={dead ? `${styles.terminalPane} ${styles.terminalExited}` : styles.terminalPane} />;
}

function LoadedPanel({ rt, card, onClose }: { rt: TerminalRuntime; card?: boolean; onClose: () => void }) {
  const { useTerminals, newTab, startDirectory, selectTab, requestCloseTab, tabTitle, activeSession } = rt;
  const tabs = useTerminals((s) => s.tabs);
  const sessions = useTerminals((s) => s.sessions);
  const activeTab = useTerminals((s) => s.activeTab);
  const [cwd, setCwd] = useState<string | null>(null);
  const focusRaf = useRef(0);
  const focusActive = () => {
    cancelAnimationFrame(focusRaf.current);
    focusRaf.current = requestAnimationFrame(() => activeSession()?.focus());
  };

  const explicitCwd = useHomeTerminal((s) => s.cwd);
  // First open: resolve the workspace directory and ensure a tab to show.
  useEffect(() => {
    let live = true;
    void (async () => {
      const dir = explicitCwd ?? (await resolveHomeCwd());
      if (!live || !dir || !(await ensureHomeCwd(dir))) return;
      if (!live) return;
      setCwd(dir);
      if (useTerminals.getState().tabs.length === 0) newTab(startDirectory(dir));
      focusActive();
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explicitCwd]);

  const openTab = () => {
    if (!cwd) return;
    newTab(startDirectory(cwd));
    focusActive();
  };

  const closeTab = async (id: string) => {
    if (!(await requestCloseTab(id))) return;
    // The drawer is only useful with a shell in it: replace the last tab.
    if (useTerminals.getState().tabs.length === 0 && cwd) newTab(startDirectory(cwd));
    else focusActive();
  };

  const items: TabItem[] = tabs.map((t) => {
    const status = sessions[t.session]?.status;
    const dead = status === "exited" || status === "error";
    return {
      id: t.id,
      label: tabTitle(t, sessions),
      closable: true,
      italic: dead,
      color: dead ? "var(--fg-subtle)" : undefined,
      tooltip: sessions[t.session]?.cwd,
    };
  });
  const sessionKey = tabs.find((t) => t.id === activeTab)?.session ?? null;

  return (
    <div className={card ? styles.terminalCard : styles.terminalDrawer} role="complementary" aria-label="Terminal">
      <div className={styles.terminalHeader}>
        <Icon name="terminal" size={16} />
        <span className={styles.terminalTitle}>
          <T>Terminal</T>
        </span>
        {cwd && (
          <span className={styles.terminalCwd} title={cwd}>
            {basename(cwd)}
          </span>
        )}
        <span className={styles.terminalSpacer} />
        <IconButton icon="plus" size="small" title="New Tab" onClick={openTab} />
        <IconButton icon="close" size="small" title="Close" onClick={onClose} />
      </div>
      <Tabs
        variant="compact"
        className={styles.terminalStrip}
        aria-label="Terminal sessions"
        items={items}
        activeId={activeTab}
        onSelect={(id) => {
          selectTab(id);
          focusActive();
        }}
        onClose={(id) => void closeTab(id)}
        panelIdPrefix="home-terminal"
      />
      <div className={styles.terminalBody}>{sessionKey && <HomeTerminalPane rt={rt} sessionKey={sessionKey} />}</div>
    </div>
  );
}

/**
 * The home terminal: an overlay drawer by default, or an inline rounded card
 * (`card`) docked into the cowork session's right quarter. The runtime (and
 * its xterm chunk) loads on first open.
 */
export function HomeTerminalPanel({ card, onClose }: { card?: boolean; onClose: () => void }) {
  const [rt, setRt] = useState<TerminalRuntime | null>(null);
  useEffect(() => {
    let live = true;
    void loadTerminalRuntime().then((m) => {
      if (live) setRt(m);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!rt) {
    return (
      <div className={card ? styles.terminalCard : styles.terminalDrawer} role="complementary" aria-label="Terminal">
        <div className={styles.terminalHeader}>
          <Icon name="terminal" size={16} />
          <span className={styles.terminalTitle}>
            <T>Terminal</T>
          </span>
          <span className={styles.terminalSpacer} />
          <IconButton icon="close" size="small" title="Close" onClick={onClose} />
        </div>
      </div>
    );
  }
  return <LoadedPanel rt={rt} card={card} onClose={onClose} />;
}
