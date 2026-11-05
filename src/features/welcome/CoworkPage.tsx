/** Agent-first home: greeting + task composer; tasks rail; placeholders. */
import { useMemo, useState, type ComponentProps } from "react";
import type { AgentStatus } from "@/bindings";
import { useT } from "@/platform/i18n";
import { Icon } from "@/ui";
import { HomeEditor } from "@/features/agents/HomeEditor";
import { CoworkSession } from "@/features/agents/SessionEditor";
import { openCoworkTask, openTask, useAgents } from "@/features/agents/store";
import { HomeTerminalButton, HomeTerminalPanel } from "./HomeTerminal";
import styles from "./Cowork.module.css";

type IconName = ComponentProps<typeof Icon>["name"];

/** Center column: greeting and the real task composer, or the open task when one is selected. */
export function CoworkHome() {
  const t = useT();
  const coworkTask = useAgents((s) => s.coworkTask);
  const task = useAgents((s) => (coworkTask ? s.tasks.get(coworkTask) : undefined));
  const [terminalOpen, setTerminalOpen] = useState(false);
  if (coworkTask && task) {
    return (
      <div className={styles.home}>
        <div className={styles.sessionWrap}>
          <button type="button" className={styles.backButton} onClick={() => openCoworkTask(null)}>
            <Icon name="arrow-left" size={14} />
            {t("cowork.back")}
          </button>
          <CoworkSession id={coworkTask} />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.home}>
      <div className={styles.topActions}>
        <HomeTerminalButton open={terminalOpen} onToggle={() => setTerminalOpen((v) => !v)} />
      </div>
      <HomeEditor heading={<span className={styles.greeting}>{t("cowork.greeting")}</span>} />
      {terminalOpen && <HomeTerminalPanel onClose={() => setTerminalOpen(false)} />}
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
