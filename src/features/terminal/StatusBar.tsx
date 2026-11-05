/**
 * Status strip under a tab group's terminal: the shell and directory, the
 * running program, or how the session ended (with a restart action).
 */
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { IconButton, tooltipAttrs } from "@/ui";
import { getSession, trimMiddle, useTerminals } from "./store";
import type { SessionSnapshot } from "./session";
import styles from "./Terminal.module.css";

export type StatusTone = "idle" | "busy" | "done" | "bad";

const TONE_CLASS = {
  idle: styles.dotIdle,
  busy: styles.dotBusy,
  done: styles.dotDone,
  bad: styles.dotBad,
};

/** Dot colour for a session: blue while starting or running, green/red once it ends. */
export function statusTone(s: SessionSnapshot): StatusTone {
  if (s.status === "starting" || s.commandRunning) return "busy";
  if (s.status === "running" || s.status === "idle") return "idle";
  if (s.status === "exited" && (s.exitCode ?? 0) === 0) return "done";
  return "bad";
}

const CWD_MAX = 48;

export function TerminalStatusBar({ sessionKey }: { sessionKey: string }) {
  const session = useTerminals((s) => s.sessions[sessionKey]);
  if (!session) return null;
  const exited = session.status === "exited" || session.status === "error";
  const failed = session.status === "error" || (session.exitCode ?? 0) !== 0;
  const main =
    session.status === "starting"
      ? tx("Starting…")
      : session.commandRunning
        ? (session.appTitle ?? tx("Running"))
        : exited
          ? tx("Session finished")
          : [session.title, trimMiddle(session.cwd, CWD_MAX)].filter(Boolean).join(" · ");
  return (
    <div className={styles.statusBar} role="status">
      <span className={clsx(styles.dot, TONE_CLASS[statusTone(session)])} aria-hidden="true" />
      <span className={styles.statusText} {...tooltipAttrs(exited ? undefined : session.cwd)}>
        {main}
      </span>
      {exited && session.exitCode !== null && (
        <span className={clsx(styles.code, failed && styles.codeBad)}>exit {session.exitCode}</span>
      )}
      {exited && (
        <IconButton
          icon="rerun"
          size="small"
          title="Restart Session"
          onClick={() => getSession(sessionKey)?.restart()}
        />
      )}
    </div>
  );
}
