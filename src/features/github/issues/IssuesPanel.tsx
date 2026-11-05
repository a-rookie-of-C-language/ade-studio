/**
 * The issues tab's panel: the Open/Closed filter, a progress stripe while
 * loading, and the repository's issues (pull requests the endpoint also lists
 * are left out), 50 per load. Enter or a double-click opens the selected issue
 * in a browser.
 *
 * The context menu is `Github.Issue.ToolWindow.List.Popup`: Start Work in
 * Worktree (a `issue-<n>-<slug>` branch opened in `<root>_ISSUE_<n>`), open in
 * a browser, copy the URL.
 */
import { useEffect, type MouseEvent } from "react";
import { useTx } from "@/platform/i18n";
import { EmptyState, List, ProgressBar, Select, showContextMenu, T, type MenuItem } from "@/ui";
import { useGhRepository } from "../data/repository";
import { IssueRow } from "./IssueRow";
import { openIssueInBrowser, reloadIssues, setIssuesFilter, setIssuesSelection, useGhIssues } from "./data";
import type { IssueStateFilter } from "./model";
import styles from "./Issues.module.css";

/** Row height: 4px + the 24px first line + the 16px info line + 5px. */
const ROW_HEIGHT = 49;

/** `Github.Issue.ToolWindow.List.Popup`. */
function contextMenu(number: number): MenuItem[] {
  return [
    { kind: "action", action: "github.issue.startWorktree", arg: number },
    { kind: "action", action: "github.issue.openInBrowser", arg: number },
    { kind: "action", action: "github.issue.copyUrl", arg: number },
    { kind: "separator" },
    { kind: "action", action: "github.refreshIssues", label: "Refresh List" },
  ];
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className={styles.error}>
      <EmptyState
        title="Can't load issues"
        actions={
          <button type="button" className={styles.emptyLink} onClick={() => void reloadIssues()}>
            <T>Retry</T>
          </button>
        }
      >
        <div className={styles.errorBody}>{error}</div>
      </EmptyState>
    </div>
  );
}

export function IssuesPanel() {
  const t = useTx();
  const connection = useGhRepository((s) => s.connection);
  const { items, loading, error, loaded, filter, selection } = useGhIssues();

  useEffect(() => {
    if (connection && !loaded && !loading && !error) void reloadIssues();
  }, [connection, loaded, loading, error]);

  if (!connection) return null;
  const index = items.findIndex((i) => i.number === selection);
  const onContextMenu = (issue: { number: number }, _i: number, e: MouseEvent) => {
    e.preventDefault();
    setIssuesSelection(issue.number);
    showContextMenu(e, contextMenu(issue.number));
  };

  const empty = loading ? (
    <EmptyState title="Loading…" />
  ) : filter === "OPEN" ? (
    <EmptyState title={t`No open issues in ${connection.coordinates.name}`} />
  ) : (
    <EmptyState title={t`No closed issues in ${connection.coordinates.name}`} />
  );

  return (
    <div className={styles.panel}>
      <div className={styles.filter}>
        <Select<IssueStateFilter>
          value={filter}
          options={[
            { value: "OPEN", label: "Open" },
            { value: "CLOSED", label: "Closed" },
          ]}
          onChange={(v) => setIssuesFilter(v)}
          aria-label="Issue state"
        />
      </div>
      <div className={styles.body}>
        {loading && <ProgressBar className={styles.stripe} aria-label="Loading…" />}
        {error ? (
          <ErrorState error={error} />
        ) : (
          <List
            items={items}
            getKey={(i) => `issue-${i.number}`}
            rowHeight={ROW_HEIGHT}
            activeIndex={index}
            onActiveChange={(i) => setIssuesSelection(items[i]?.number ?? null)}
            onActivate={(issue, _i, e) => {
              // Enter or a double-click (`CommonShortcuts.ENTER`, `DOUBLE_CLICK_1`).
              if (e.type === "click" && (e as MouseEvent).detail !== 2) return;
              void openIssueInBrowser(issue.number);
            }}
            onContextMenu={onContextMenu}
            aria-label="Issues"
            className={styles.list}
            empty={empty}
            renderItem={(issue) => <IssueRow issue={issue} />}
          />
        )}
      </div>
    </div>
  );
}
