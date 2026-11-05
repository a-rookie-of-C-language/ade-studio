/** Welcome › Projects: the agent workspace picker (search, open a folder, recent workspaces). */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import {
  Button,
  HighlightedText,
  Icon,
  IconButton,
  SearchField,
  isPopupOpen,
  listNavigate,
  showContextMenu,
  T,
} from "@/ui";
import { askRemoveRecent, groupMenu, ProjectBadge, recentMenu } from "./RecentList";
import { recentRows, setGroupExpanded, useRecent, type RecentMatch, type RecentRow } from "./recent";
import { clearWorkspace, openWorkspaceDialog, selectWorkspace, useWorkspace } from "./workspace";
import type { RecentProjectGroup } from "@/platform/ipc";
import styles from "./Welcome.module.css";
import { tx } from "@/platform/i18n";

function HeaderButtons({ onPick }: { onPick?: () => void }) {
  return (
    <div className={styles.headerButtons}>
      <Button
        onClick={() =>
          void openWorkspaceDialog().then((ok) => {
            if (ok) onPick?.();
          })
        }
      >
        <T>Open</T>
      </Button>
    </div>
  );
}

/** Shown when there are no recent workspaces yet. */
function Landing({ onPick }: { onPick?: () => void }) {
  return (
    <div className={styles.landing}>
      <div className={styles.landingTitle}>
        <T>Welcome to OpenIDEA</T>
      </div>
      <p className={styles.landingText}>{tx("Open a folder from disk to use it as your agent workspace.")}</p>
      <div className={styles.landingActions}>
        <button
          type="button"
          className={styles.landingAction}
          onClick={() =>
            void openWorkspaceDialog().then((ok) => {
              if (ok) onPick?.();
            })
          }
        >
          <span className={styles.landingIcon}>
            <Icon name="folder-open" size={20} />
          </span>
          <T>Open</T>
        </button>
      </div>
    </div>
  );
}

/** Pinned row for the default workspace (`~/.openidea/workspace`). */
function DefaultRow({ current, onPick }: { current: boolean; onPick?: () => void }) {
  return (
    <div
      role="option"
      aria-selected={current}
      title="~/.openidea/workspace"
      className={clsx(styles.project, current && styles.projectSelected)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        clearWorkspace();
        onPick?.();
      }}
    >
      <Icon name="folder" size={16} />
      <span className={styles.projectText}>
        <span className={styles.projectName}>
          <T>Default workspace</T>
        </span>
        <span className={styles.projectPath}>~/.openidea/workspace</span>
      </span>
      {current && (
        <span className={styles.currentBadge}>
          <T>Current</T>
        </span>
      )}
    </div>
  );
}

/** A project group: click or Enter folds it, its menu renames or removes it. */
function GroupRow({
  group,
  count,
  id,
  selected,
  onSelect,
}: {
  group: RecentProjectGroup;
  count: number;
  id: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      aria-expanded={group.expanded}
      className={clsx(styles.project, styles.group, selected && styles.projectSelected)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onSelect();
        void setGroupExpanded(group.name, !group.expanded);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        showContextMenu(e, groupMenu(group));
      }}
    >
      <Icon name={group.expanded ? "chevron-down" : "chevron-right"} size={16} />
      <Icon name="folder" size={16} />
      <span className={styles.groupName}>{group.name}</span>
      <span className={styles.groupCount}>{count}</span>
      <IconButton
        icon="more"
        title="Group actions"
        aria-haspopup="menu"
        iconSize={16}
        className={styles.projectMore}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          const r = e.currentTarget.getBoundingClientRect();
          showContextMenu({ x: r.left, y: r.bottom + 2 }, groupMenu(group));
        }}
      />
    </div>
  );
}

function ProjectRow({
  m,
  id,
  selected,
  nested,
  current,
  onSelect,
  onOpen,
}: {
  m: RecentMatch;
  id: string;
  selected: boolean;
  /** Listed under a group. */
  nested?: boolean;
  /** The agent workspace points here. */
  current?: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      title={m.project.path}
      className={clsx(styles.project, nested && styles.projectNested, selected && styles.projectSelected)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        showContextMenu(e, recentMenu(m.project));
      }}
    >
      <ProjectBadge name={m.project.name} className={styles.projectBadge} />
      <span className={styles.projectText}>
        <HighlightedText className={styles.projectName} text={m.project.name} indices={m.nameMatch} tone="strong" />
        <HighlightedText className={styles.projectPath} text={m.displayPath} indices={m.pathMatch} />
        {m.project.branch && (
          <span className={styles.projectBranch}>
            <Icon name="branch" size={14} />
            <span className={styles.projectBranchName}>{m.project.branch}</span>
          </span>
        )}
      </span>
      {current && (
        <span className={styles.currentBadge}>
          <T>Current</T>
        </span>
      )}
      <IconButton
        icon="open-in-tool-window"
        title="Open in IDE"
        iconSize={16}
        className={styles.projectMore}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          void executeAction("welcome.openInIDE", m.project.path);
        }}
      />
      <IconButton
        icon="more"
        title="Project actions"
        aria-haspopup="menu"
        iconSize={16}
        className={styles.projectMore}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          const r = e.currentTarget.getBoundingClientRect();
          showContextMenu({ x: r.left, y: r.bottom + 2 }, recentMenu(m.project));
        }}
      />
    </div>
  );
}

/** Keys shared by the search field and the list. Returns true when handled. */
export function handleListKey<T>(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey">,
  ctx: { items: readonly T[]; current: number; caretAtEnd: boolean },
): { kind: "move"; index: number } | { kind: "open" | "remove" | "menu"; match: T } | null {
  const m = ctx.items[ctx.current];
  if (e.key === "Enter") return m ? { kind: "open", match: m } : null;
  if (m && ((e.key === "Delete" && ctx.caretAtEnd) || (e.key === "Backspace" && e.metaKey)))
    return { kind: "remove", match: m };
  if (m && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return { kind: "menu", match: m };
  const next = listNavigate(e.key, { items: ctx.items, active: ctx.current, pageSize: 8 });
  return next === null ? null : { kind: "move", index: next };
}

export function ProjectsPage({ onPick }: { onPick?: () => void }) {
  const projects = useRecent((s) => s.projects);
  const groups = useRecent((s) => s.groups);
  const loaded = useRecent((s) => s.loaded);
  const home = useRecent((s) => s.home);
  const wsRoot = useWorkspace((s) => s.root);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const items = useMemo(() => recentRows(projects, groups, query, home), [projects, groups, query, home]);
  const current = Math.max(0, Math.min(active, items.length - 1));
  // A row click points the home workspace there and goes back to the composer.
  const pick = (path: string) =>
    void selectWorkspace(path).then((ok) => {
      if (ok) onPick?.();
    });

  if (!loaded) return null;
  if (projects.length === 0) return <Landing onPick={onPick} />;

  const optionId = (i: number) => `${baseId}-p${i}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const caretAtEnd =
      !input || (input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
    const row = items[current];
    // A group folds with ← / → (and Enter, below), like a tree node.
    if (row?.kind === "group" && !input && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      void setGroupExpanded(row.group.name, e.key === "ArrowRight");
      return;
    }
    const r = handleListKey(e, { items, current, caretAtEnd });
    if (!r) {
      // Typing in the list goes to the search field.
      if (!input && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setQuery((q) => q + e.key);
        setActive(0);
        search.current?.focus();
      }
      return;
    }
    e.preventDefault();
    if (r.kind === "move") {
      setActive(r.index);
      return;
    }
    const match: RecentRow = r.match;
    if (match.kind === "group") {
      if (r.kind === "open") void setGroupExpanded(match.group.name, !match.group.expanded);
      else if (r.kind === "menu") {
        const el = document.getElementById(optionId(current))?.getBoundingClientRect();
        showContextMenu({ x: (el?.right ?? 0) - 40, y: (el?.top ?? 0) + 24 }, groupMenu(match.group));
      }
      return;
    }
    if (r.kind === "open") pick(match.m.project.path);
    else if (r.kind === "remove") void askRemoveRecent(match.m.project);
    else {
      const el = document.getElementById(optionId(current))?.getBoundingClientRect();
      showContextMenu({ x: (el?.right ?? 0) - 40, y: (el?.top ?? 0) + 24 }, recentMenu(match.m.project));
    }
  };

  return (
    <div className={styles.projects}>
      <div className={styles.header}>
        <SearchField
          ref={search}
          variant="bare"
          value={query}
          onChange={(q) => {
            setQuery(q);
            setActive(0);
          }}
          placeholder="Search projects"
          aria-label="Search projects"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={items.length ? optionId(current) : undefined}
          autoFocus={!isPopupOpen()}
          data-autofocus
          onKeyDown={onKeyDown}
          className={styles.search}
        />
        <HeaderButtons onPick={onPick} />
      </div>
      {!query && <DefaultRow current={wsRoot === null} onPick={onPick} />}
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label={tx("Recent projects")}
        tabIndex={-1}
        className={styles.projectList}
        onKeyDown={onKeyDown}
      >
        {items.map((row, i) =>
          row.kind === "group" ? (
            <GroupRow
              key={`group:${row.group.name}`}
              group={row.group}
              count={row.count}
              id={optionId(i)}
              selected={i === current}
              onSelect={() => setActive(i)}
            />
          ) : (
            <ProjectRow
              key={row.m.project.path}
              m={row.m}
              id={optionId(i)}
              selected={i === current}
              nested={row.group !== null}
              current={wsRoot === row.m.project.path}
              onSelect={() => setActive(i)}
              onOpen={() => pick(row.m.project.path)}
            />
          ),
        )}
        {items.length === 0 && (
          <div className={styles.noMatches}>
            <T>No matching projects</T>
          </div>
        )}
      </div>
    </div>
  );
}
