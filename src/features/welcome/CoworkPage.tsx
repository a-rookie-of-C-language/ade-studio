/** Agent-first home: greeting + task composer + ideas; tasks rail; placeholders. */
import { useMemo, type ComponentProps } from "react";
import type { AgentStatus } from "@/bindings";
import { useT } from "@/platform/i18n";
import { Icon } from "@/ui";
import { HomeEditor } from "@/features/agents/HomeEditor";
import { HOME, focusComposer, openTask, updateComposer, useAgents } from "@/features/agents/store";
import styles from "./Cowork.module.css";

type IconName = ComponentProps<typeof Icon>["name"];

const IDEAS = ["cowork.idea.explain", "cowork.idea.review", "cowork.idea.next"] as const;

/** Center column: greeting, the real task composer, then one-click ideas. */
export function CoworkHome() {
  const t = useT();
  return (
    <div className={styles.home}>
      <HomeEditor heading={<span className={styles.greeting}>{t("cowork.greeting")}</span>} />
      <section className={styles.ideas} aria-label={t("cowork.ideas")}>
        <h2 className={styles.ideasTitle}>{t("cowork.ideas")}</h2>
        <ul className={styles.ideaList}>
          {IDEAS.map((key) => (
            <li key={key}>
              <button
                type="button"
                className={styles.idea}
                onClick={() => {
                  updateComposer(HOME, { text: t(key) });
                  focusComposer(HOME);
                }}
              >
                <Icon name="bulb" size={16} />
                <span>{t(key)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

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

/** Sidebar rail: recent agent tasks, newest first. Empty until tasks exist. */
export function CoworkTasks() {
  const t = useT();
  const map = useAgents((s) => s.tasks);
  const tasks = useMemo(
    () =>
      [...map.values()]
        .filter((task) => task.status !== "archived")
        .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0))
        .slice(0, 8),
    [map],
  );
  return (
    <section className={styles.tasks} aria-label={t("cowork.tasks")}>
      <h2 className={styles.tasksTitle}>{t("cowork.tasks")}</h2>
      {tasks.length === 0 ? (
        <p className={styles.tasksEmpty}>{t("cowork.emptyTasks")}</p>
      ) : (
        <ul className={styles.taskList}>
          {tasks.map((task) => (
            <li key={task.id}>
              <button type="button" className={styles.task} title={task.title} onClick={() => openTask(task.id)}>
                <span className={statusClass(task.status)} aria-hidden />
                <span className={styles.taskTitle}>{task.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Honest placeholder for pages with no backend yet. */
export function CoworkSoon({ icon, title, hint }: { icon: IconName; title: string; hint: string }) {
  const t = useT();
  return (
    <div className={styles.soon}>
      <p className={styles.soonEyebrow}>{t("cowork.soon.title")}</p>
      <Icon name={icon} size={32} className={styles.soonIcon} />
      <h1 className={styles.soonTitle}>{title}</h1>
      <p className={styles.soonHint}>{hint}</p>
    </div>
  );
}
