/** Home sidebar: tasks rail (the center is the embedded Cindy interface). */
import { useMemo } from "react";
import type { AgentStatus, AgentTask } from "@/bindings";
import { useT, useTx } from "@/platform/i18n";
import { Icon, IconButton, tooltipAttrs } from "@/ui";
import { isPinned, openTask, togglePin, useAgents } from "@/features/agents/store";
import styles from "./Cowork.module.css";

function statusClass(status: AgentStatus) {
  switch (status) {
    case "running":
    case "starting":
      return `${styles.dot} ${styles.dotActive}`;
    case "needsInput":
    case "limited":
      return `${styles.dot} ${styles.dotWaiting}`;
    case "failed":
      return `${styles.dot} ${styles.dotFailed}`;
    default:
      return styles.dot;
  }
}

/** Last path segment on either separator (tasks carry native paths like `D:\…`). */
export function projectName(path: string): string {
  const seg = path.split(/[/\\]/).pop() ?? "";
  return seg || path;
}

export interface TaskGroup {
  /** `projectRoot ?? cwd` of its tasks; "" when the task recorded neither. */
  key: string;
  items: AgentTask[];
}

/** Newest-first tasks (archived excluded), bucketed by project, groups newest-first. */
export function groupTasksByProject(all: Iterable<AgentTask>, limit = 30): TaskGroup[] {
  const tasks = [...all]
    .filter((task) => task.status !== "archived")
    .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0))
    .slice(0, limit);
  const byProject = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    const key = task.projectRoot ?? task.cwd ?? "";
    const list = byProject.get(key);
    if (list) list.push(task);
    else byProject.set(key, [task]);
  }
  // Each group's first item is its latest task, so this orders groups newest-first.
  return [...byProject.entries()]
    .sort((a, b) => (b[1][0]?.updatedMs ?? 0) - (a[1][0]?.updatedMs ?? 0))
    .map(([key, items]) => ({ key, items }));
}

/** Sidebar rail: recent agent tasks grouped by project, newest first. Empty until tasks exist. */
export function CoworkTasks({ onNewInProject }: { onNewInProject?: (path: string) => void }) {
  const t = useT();
  const map = useAgents((s) => s.tasks);
  const pinned = useAgents((s) => s.pinned);
  const groups = useMemo(() => groupTasksByProject(map.values()), [map]);
  const pinnedTasks = useMemo(
    () =>
      pinned.flatMap((id) => {
        const task = map.get(id);
        return task && task.status !== "archived" ? [task] : [];
      }),
    [pinned, map],
  );
  return (
    <section className={styles.tasks} aria-label={t("cowork.tasks")}>
      <h2 className={styles.tasksTitle}>{t("cowork.tasks")}</h2>
      {pinnedTasks.length > 0 && (
        <div className={styles.taskGroup}>
          <h3 className={styles.taskGroupName}>{t("cowork.pinned")}</h3>
          <ul className={styles.taskGroupList}>
            {pinnedTasks.map((task) => (
              <TaskRow key={task.id} task={task} pinned />
            ))}
          </ul>
        </div>
      )}
      {groups.length === 0 && pinnedTasks.length === 0 ? (
        <p className={styles.tasksEmpty}>{t("cowork.emptyTasks")}</p>
      ) : (
        <div className={styles.taskList}>
          {groups.map((group) => (
            <div key={group.key || "default"} className={styles.taskGroup}>
              {group.key ? (
                <div className={styles.taskGroupHead}>
                  <h3 className={styles.taskGroupName} {...tooltipAttrs(group.key)}>
                    {projectName(group.key)}
                  </h3>
                  {onNewInProject && (
                    <IconButton
                      icon="plus"
                      size="small"
                      title="New task in this project"
                      className={styles.taskGroupAdd}
                      onClick={() => onNewInProject(group.key)}
                    />
                  )}
                </div>
              ) : null}
              <ul className={styles.taskGroupList}>
                {group.items.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** One task row with a pin toggle (always visible when pinned, on hover otherwise). */
function TaskRow({ task, pinned }: { task: AgentTask; pinned?: boolean }) {
  const tx = useTx();
  const isTaskPinned = pinned ?? isPinned(task.id);
  return (
    <li className={styles.taskItem}>
      <button type="button" className={styles.task} {...tooltipAttrs(task.title)} onClick={() => openTask(task.id)}>
        <span className={statusClass(task.status)} aria-hidden />
        <span className={styles.taskTitle}>{task.title}</span>
      </button>
      <button
        type="button"
        className={`${styles.pinButton} ${isTaskPinned ? styles.pinButtonOn : ""}`}
        title={isTaskPinned ? tx("Unpin Task") : tx("Pin Task")}
        aria-label={isTaskPinned ? tx("Unpin Task") : tx("Pin Task")}
        aria-pressed={isTaskPinned}
        onClick={() => togglePin(task.id)}
      >
        <Icon name="pin" size={13} />
      </button>
    </li>
  );
}
