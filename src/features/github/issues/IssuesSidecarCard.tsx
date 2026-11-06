/**
 * The cowork task's repository issues for the session sidecar: Cowork has no
 * Pull Requests tool window, so this card connects the task's own root and
 * reuses `IssuesPanel` directly. Tool-window actions stay disabled without an
 * open project (`projectOpen`), so the context menu calls the same helpers
 * directly instead of going through action ids.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { Button, EmptyState, Icon, IconButton, T, type MenuItem } from "@/ui";
import { connect, refreshConnectionForRoot, sameRepository, useGhRepository } from "../data/repository";
import { copyIssueUrl, openIssueInBrowser, reloadIssues, resetIssues, startIssueWorktree } from "./data";
import { IssuesPanel } from "./IssuesPanel";
import styles from "./Issues.module.css";

/** The tool-window issue menu with the helpers called directly (no `projectOpen`). */
function directMenu(number: number): MenuItem[] {
  return [
    { label: "Start Work in Worktree", run: () => void startIssueWorktree(number) },
    { label: "View Issue in Browser", run: () => void openIssueInBrowser(number) },
    { label: "Copy Issue URL", run: () => void copyIssueUrl(number) },
    { kind: "separator" },
    { label: "Refresh List", run: () => void reloadIssues() },
  ];
}

/** Compact connection state: the tool window's `Unavailable` without the repository selector. */
function ConnectionHint({ root }: { root: string }) {
  const availability = useGhRepository((s) => s.availability);
  const checking = useGhRepository((s) => s.checking);
  const connecting = useGhRepository((s) => s.connecting);
  const retry = (
    <Button size="small" onClick={() => void refreshConnectionForRoot(root)}>
      <T>Retry</T>
    </Button>
  );
  if (!availability || checking || connecting) return <EmptyState title="Loading…" />;
  switch (availability.kind) {
    case "notInstalled":
      return <EmptyState title="GitHub CLI is not installed" actions={retry} />;
    case "notLoggedIn":
      return <EmptyState title="Not logged in to GitHub" actions={retry} />;
    case "notGitHub":
      return (
        <EmptyState title="No GitHub repository" actions={retry}>
          <div className={styles.sidecarHint}>{root}</div>
          <div className={styles.sidecarHint}>{availability.message}</div>
        </EmptyState>
      );
    case "error":
      return (
        <EmptyState title="Could not reach GitHub" actions={retry}>
          <div className={styles.sidecarHint}>{root}</div>
          <div className={styles.sidecarHint}>{availability.message}</div>
        </EmptyState>
      );
    default:
      return null;
  }
}

export function IssuesSidecarCard({ task }: { task: AgentTask }) {
  const [open, setOpen] = useState(true);
  const tx = useTx();
  const project = useProject((s) => s.project);
  const root = task.projectRoot ?? task.cwd ?? null;
  const connection = useGhRepository((s) => s.connection);

  useEffect(() => {
    if (project || !root) return;
    let live = true;
    resetIssues();
    void (async () => {
      await refreshConnectionForRoot(root);
      if (!live) return;
      // No repository selector in the sidecar: take gh's own choice, else the first remote.
      const s = useGhRepository.getState();
      if (!s.connection && s.availability?.kind === "ready" && s.remotes.length > 0) {
        const pick = (s.defaultRemote && s.remotes.find((r) => sameRepository(r, s.defaultRemote))) ?? s.remotes[0]!;
        await connect(pick, { remember: false });
      }
    })();
    return () => {
      live = false;
    };
  }, [project, root]);

  // Inside the IDE the Pull Requests tool window owns issues; without a local
  // root there is nothing to connect.
  if (project || !root) return null;
  return (
    <section className={styles.sidecar} aria-label={tx("Issues")}>
      <div className={styles.sidecarHead}>
        <button type="button" className={styles.sidecarToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          <T>Issues</T>
          {connection && <span className={styles.sidecarRepo}>{connection.coordinates.name}</span>}
          <Icon name="chevron-down" size={14} className={clsx(styles.sidecarChevron, !open && styles.collapsed)} />
        </button>
        <IconButton icon="refresh" title={tx("Refresh Issues List")} size="small" onClick={() => void reloadIssues()} />
      </div>
      {open && (
        <>
          {connection ? (
            <div className={styles.sidecarBody}>
              <IssuesPanel menu={directMenu} />
            </div>
          ) : (
            <ConnectionHint root={root} />
          )}
        </>
      )}
    </section>
  );
}
