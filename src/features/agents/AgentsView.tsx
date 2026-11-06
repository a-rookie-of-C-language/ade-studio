/** Agents tool window: a chat panel showing one conversation; the task list
 * and external sessions live in the history popup behind the title button. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import type { AgentStatus as Status, AgentTask, ExternalSession } from "@/bindings";
import { EDITOR_TAB_MIME, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import {
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Popup,
  Spinner,
  T,
  Tree,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  tooltipAttrs,
} from "@/ui";
import { SESSION_KIND, TASK_DRAG, age, branchLabel, groupTasks, sessionKey, type TaskGroup } from "./model";
import { importExternal, openHome, openTask, refreshExternal, useAgents } from "./store";
import { taskMenu } from "./taskActions";
import { SessionEditor } from "./SessionEditor";
import { HomeEditor } from "./HomeEditor";
import styles from "./Agents.module.css";
import { basename, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { showError } from "@/workbench/messages";

export function AgentsHeaderActions() {
  return <IconButton icon="plus" action="agents.newTask" size="small" />;
}

type Node = { kind: "group"; group: TaskGroup } | { kind: "task"; task: AgentTask };

const nodeKey = (n: Node) => (n.kind === "group" ? `g:${n.group.status}` : n.task.id);

const sessionTask = (input: EditorInput | null | undefined) =>
  input?.kind === SESSION_KIND ? (input.data as { task?: string } | undefined)?.task : undefined;

/** The task of an editor tab drag payload (session tabs only), null for anything else. */
const sessionPayloadTask = (payload: string): string | null => {
  try {
    const p = JSON.parse(payload) as { paneId?: unknown; tabId?: unknown };
    if (typeof p.paneId !== "string" || typeof p.tabId !== "string") return null;
    const input = maybeEditorService()?.tabInput?.(p.paneId, p.tabId);
    return input?.kind === SESSION_KIND ? ((input.data as { task?: string }).task ?? null) : null;
  } catch {
    return null;
  }
};

export function TaskStatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "running":
    case "starting":
      return <Spinner size={11} />;
    case "ready":
      return <Icon name="check" size={13} className={styles.ready} label="Ready" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.failed} label="Failed" />;
    case "limited":
      return <Icon name="clock" size={13} className={styles.failed} label="Usage limit" />;
    case "archived":
      return <Icon name="minus" size={13} className={styles.archived} label="Archived" />;
  }
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Sessions created outside OpenIDEA (another Codex or Claude client): import one to
 * resume it as a task of this project, under its own session id. */
function ExternalSessions() {
  const tx = useTx();
  const project = useProject((s) => s.project);
  const external = useAgents((s) => s.external);
  const externalError = useAgents((s) => s.externalError);
  const providers = useAgents((s) => s.providers);
  const [projectOnly, setProjectOnly] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const visible = useMemo(() => {
    if (!projectOnly || !project) return external;
    const root = normPath(project.root);
    return external.filter(
      (s) => s.cwd != null && (normPath(s.cwd) === root || normPath(s.cwd).startsWith(`${root}/`)),
    );
  }, [external, projectOnly, project]);
  const doImport = (s: ExternalSession) => {
    if (busy.has(s.sessionId)) return;
    setBusy((b) => new Set(b).add(s.sessionId));
    const done = () =>
      setBusy((b) => {
        const next = new Set(b);
        next.delete(s.sessionId);
        return next;
      });
    importExternal(s).then(
      (task) => {
        done();
        openTask(task.id);
      },
      async (e: unknown) => {
        done();
        await showError(tx("Couldn't import the session"), e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <div className={styles.external}>
      <div className={styles.externalBar}>
        <IconButton
          icon={collapsed ? "chevron-right" : "chevron-down"}
          title={tx("External sessions")}
          size="small"
          onClick={() => setCollapsed((c) => !c)}
        />
        <span className={styles.groupLabel}>
          <T>External sessions</T>
        </span>
        <span className={styles.count}>{visible.length}</span>
        <span className={styles.externalSpacer} />
        {project && <Checkbox checked={projectOnly} onChange={setProjectOnly} aria-label={tx("Only this project")} />}
        <IconButton
          icon="refresh"
          title={tx("Refresh external sessions")}
          size="small"
          onClick={() => void refreshExternal()}
        />
      </div>
      {!collapsed &&
        (externalError ? (
          <div className={styles.externalError}>
            <T>Cannot load external sessions</T>
            {externalError ? `: ${externalError}` : ""}
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.externalEmpty}>
            <T>No external sessions yet</T>
          </div>
        ) : (
          <ul className={styles.externalList}>
            {visible.map((s) => (
              <li key={`${s.provider}:${s.sessionId}`} className={styles.row} {...tooltipAttrs(s.cwd ?? s.sessionId)}>
                <Icon name="toolwindow-agents" size={13} label={providerName(s.provider)} />
                <span className={styles.title}>{s.title}</span>
                {s.cwd && <span className={styles.taskProject}>{basename(s.cwd)}</span>}
                <span className={styles.detail}>{providerName(s.provider)}</span>
                <span className={styles.age}>{age(s.updatedMs ?? 0)}</span>
                <button
                  type="button"
                  className={styles.link}
                  disabled={busy.has(s.sessionId)}
                  onClick={() => doImport(s)}
                >
                  {s.imported ? <T>Open</T> : <T>Import</T>}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function AgentsView() {
  const project = useProject((s) => s.project);
  const tx = useTx();
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const providers = useAgents((s) => s.providers);
  const docked = useAgents((s) => s.docked);
  const lastTask = useAgents((s) => s.lastTask);
  const homeOpen = useAgents((s) => s.homeOpen);
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => {
    const task = sessionTask(maybeEditorService()?.activeInput?.());
    return new Set(task ? [task] : []);
  });
  // Follow the active session tab.
  useEffect(
    () =>
      maybeEditorService()?.onActiveInputChange?.((input) => {
        const task = sessionTask(input);
        if (!task) return;
        setSelected((current) => (current.has(task) ? current : new Set([task])));
        const group = groupTasks(useAgents.getState().tasks.values()).find((g) => g.tasks.some((t) => t.id === task));
        const key = group && `g:${group.status}`;
        if (key) setCollapsed((c) => (c.has(key) ? new Set([...c].filter((k) => k !== key)) : c));
      }),
    [],
  );
  const roots = useMemo<Node[]>(() => groupTasks(tasks.values()).map((group) => ({ kind: "group", group })), [tasks]);
  const expanded = useMemo(() => new Set(roots.map(nodeKey).filter((k) => !collapsed.has(k))), [roots, collapsed]);
  // Newest task id for the chat panel's fallback (docked → last opened → newest).
  const newest = useMemo(() => {
    let id: string | null = null;
    let ms = -Infinity;
    for (const t of tasks.values()) {
      const m = t.updatedMs ?? 0;
      if (m > ms) {
        ms = m;
        id = t.id;
      }
    }
    return id;
  }, [tasks]);
  // Dropping a session editor tab anywhere on the tool window docks it.
  const viewRef = useRef<HTMLDivElement>(null);
  const [tabOver, setTabOver] = useState(false);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    return registerDropTarget(el, {
      accepts: (type) => type === EDITOR_TAB_MIME,
      over: (data) => setTabOver(sessionPayloadTask(data.payload) != null),
      leave: () => setTabOver(false),
      drop: (data) => {
        setTabOver(false);
        const task = sessionPayloadTask(data.payload);
        if (task) void executeAction("agents.dockTask", task);
      },
    });
  }, [loaded, error]);
  if (!loaded)
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  if (error) return <EmptyState title="Cannot load agent tasks">{error}</EmptyState>;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  // Opening any session follows the global placement preference.
  const showTask = (task: string) => {
    setHistoryOpen(false);
    void executeAction("agents.openTask", task);
  };
  // The chat panel always shows a conversation: the docked session, else the
  // last opened, else the newest task (`null`: the new-task composer).
  const valid = (id: string | null) => (id && tasks.has(id) ? id : null);
  const shown = homeOpen ? null : (valid(docked) ?? valid(lastTask) ?? newest);
  const shownTitle = shown ? (tasks.get(shown)?.title ?? shown) : null;
  const dragTask = (e: ReactPointerEvent<HTMLSpanElement>, task: string) =>
    startPointerDrag(e, e.currentTarget, { type: TASK_DRAG, payload: task });

  const taskList = (
    <div className={styles.tasks}>
      <Tree<Node>
        aria-label="Agent tasks"
        roots={roots}
        getKey={nodeKey}
        getLabel={(n) => (n.kind === "group" ? n.group.label : n.task.title)}
        getChildren={(n) =>
          n.kind === "group" ? n.group.tasks.map((task) => ({ kind: "task", task }) as Node) : undefined
        }
        isExpandable={(n) => n.kind === "group"}
        expanded={expanded}
        onExpandedChange={(_next, node, open) =>
          setCollapsed((c) => {
            const s = new Set(c);
            if (open) s.delete(nodeKey(node));
            else s.add(nodeKey(node));
            return s;
          })
        }
        selected={selected}
        // Picking in the history popup never switches on its own: a click (or
        // Enter) confirms, so keyboard and range selection can browse first.
        onSelectionChange={(sel) => {
          setSelected(sel);
        }}
        onActivate={(n) => n.kind === "task" && showTask(n.task.id)}
        onContextMenu={(n, sel, e) => {
          if (n?.kind !== "task") return;
          const selection = [...sel].flatMap((id) => {
            const task = tasks.get(id);
            return task ? [task] : [];
          });
          showContextMenu(e, taskMenu(selection));
        }}
        renderNode={(n) =>
          n.kind === "group" ? (
            <span className={styles.row}>
              <span className={styles.groupLabel}>
                <T>{n.group.label}</T>
              </span>
              <span className={styles.count}>{n.group.tasks.length}</span>
            </span>
          ) : (
            <span
              className={styles.row}
              {...tooltipAttrs(n.task.error ?? n.task.title)}
              onPointerDown={(e) => dragTask(e, n.task.id)}
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey && !e.shiftKey) showTask(n.task.id);
              }}
            >
              <TaskStatusIcon status={n.task.status} />
              <span className={styles.title} data-unread={unread.has(n.task.id) || undefined}>
                {n.task.title}
              </span>
              {unread.has(n.task.id) && (
                <span
                  className={styles.unreadDot}
                  role="img"
                  aria-label={tx("Unread")}
                  {...tooltipAttrs(tx("Unread"))}
                />
              )}
              {project?.workspace && (
                <span className={styles.taskProject} {...tooltipAttrs(n.task.projectRoot ?? project.root)}>
                  {basename(n.task.projectRoot ?? project.root)}
                </span>
              )}
              <span className={styles.detail}>
                {providerName(n.task.provider)}
                {n.task.isolation === "worktree" ? ` · ${branchLabel(n.task.branch)}` : ""}
              </span>
              <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
            </span>
          )
        }
        empty={
          <div className={styles.empty}>
            <T>No agent tasks yet</T>
            <button type="button" className={styles.link} onClick={() => openHome()}>
              <T>New Task…</T>
            </button>
          </div>
        }
      />
    </div>
  );

  return (
    <div ref={viewRef} className={clsx(styles.view, tabOver && styles.dropTarget)}>
      <div className={styles.content}>
        <div className={styles.docked}>
          <div className={styles.dockedBar}>
            <IconButton
              ref={historyRef}
              icon="history"
              title="Agent sessions"
              size="small"
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
              onClick={() => {
                setSelected(new Set(shown ? [shown] : []));
                setHistoryOpen((open) => !open);
              }}
            />
            <span
              className={styles.dockedTitle}
              {...tooltipAttrs(shownTitle ?? undefined)}
              onPointerDown={(e) => shown && dragTask(e, shown)}
            >
              {homeOpen || !shown ? <T>New Agent Task</T> : shownTitle}
            </span>
          </div>
          <div className={styles.dockedSession}>
            {homeOpen || !shown ? (
              <HomeEditor docked />
            ) : (
              <SessionEditor
                docked
                input={{
                  kind: SESSION_KIND,
                  key: sessionKey(shown),
                  data: { task: shown, title: tasks.get(shown)?.title },
                }}
              />
            )}
          </div>
        </div>
        <Popup
          open={historyOpen}
          anchor={historyRef}
          onClose={() => setHistoryOpen(false)}
          aria-label={tx("Agent sessions")}
          className={styles.history}
        >
          <div className={styles.historyTitle}>
            <T>Agent sessions</T>
          </div>
          {taskList}
          <ExternalSessions />
        </Popup>
      </div>
    </div>
  );
}
