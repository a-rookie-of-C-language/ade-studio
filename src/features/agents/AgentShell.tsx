/**
 * Agent Mode shell (TRAE screenshot, not Solo): left task nav, centered
 * session, right icon rail, `IDE` button back to the IDE frame.
 * Sessions reuse HomeEditor / SessionEditor; tasks open docked so the
 * centered column shows them without editor tabs.
 */
import { useMemo } from "react";
import { Icon, IconButton, T, tooltipAttrs } from "@/ui";
import { basename, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { SESSION_KIND, sessionKey } from "./model";
import { openHome, openTask, useAgents } from "./store";
import { setAgentMode } from "./agentMode";
import { TaskStatusIcon } from "./AgentsView";
import { HomeEditor } from "./HomeEditor";
import { SessionEditor } from "./SessionEditor";
import styles from "./AgentShell.module.css";

function Rail() {
  const tx = useTx();
  return (
    <div className={styles.rail} aria-label={tx("Agent tools")}>
      <IconButton icon="list" title={tx("Agent sessions")} size="small" disabled />
      <IconButton icon="search" action="agents.findInConversation" size="small" />
      <IconButton icon="copy" title={tx("Copy")} size="small" disabled />
      <IconButton icon="plus" action="agents.newTask" size="small" />
      <IconButton icon="file-image" title={tx("Attach image")} size="small" disabled />
      <IconButton icon="more-horizontal" title={tx("More")} size="small" disabled />
    </div>
  );
}

export function AgentShell() {
  const tx = useTx();
  const project = useProject((s) => s.project);
  const tasks = useAgents((s) => s.tasks);
  const docked = useAgents((s) => s.docked);
  const lastTask = useAgents((s) => s.lastTask);
  const homeOpen = useAgents((s) => s.homeOpen);
  const list = useMemo(() => [...tasks.values()].sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0)), [tasks]);
  const active = homeOpen ? "home" : (docked ?? lastTask ?? list[0]?.id ?? "home");
  const current = active !== "home" ? tasks.get(active) : undefined;
  const title = homeOpen || !current ? tx("New Agent Task") : current.title || tx("Agent Task");
  const projectName = project ? project.name || basename(project.root) : tx("Agent");

  return (
    <div className={styles.shell} data-agent-shell>
      <nav className={styles.side} aria-label={tx("Agent tasks")}>
        <button type="button" className={styles.sideItem} onClick={() => openHome()}>
          <Icon name="plus" size={14} />
          <T>New Task</T>
        </button>
        <button type="button" className={styles.sideItem} disabled {...tooltipAttrs(tx("Coming soon"))}>
          <Icon name="plugin" size={14} />
          <T>Plugin Market</T>
        </button>
        <button type="button" className={styles.sideItem} disabled {...tooltipAttrs(tx("Coming soon"))}>
          <Icon name="history" size={14} />
          <T>Automation</T>
        </button>
        <button type="button" className={styles.sideItem} disabled {...tooltipAttrs(tx("Coming soon"))}>
          <Icon name="package" size={14} />
          <T>My Artifacts</T>
        </button>
        <div className={styles.group}>
          <T>Pinned</T>
        </div>
        <div className={styles.group}>{projectName}</div>
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${styles.sideItem} ${styles.task}`}
            data-active={active === t.id || undefined}
            onClick={() => openTask(t.id)}
            {...tooltipAttrs(t.title)}
          >
            <TaskStatusIcon status={t.status} />
            <span>{t.title}</span>
          </button>
        ))}
        <div className={styles.group}>
          <T>Default</T>
        </div>
        {list.length === 0 && (
          <div className={styles.empty}>
            <Icon name="history" size={18} />
            <T>No tasks yet</T>
          </div>
        )}
        <div className={styles.foot}>
          <Icon name="toolwindow-agents" size={14} />
          <span>{projectName}</span>
        </div>
      </nav>
      <div className={styles.center}>
        <div className={styles.island}>
          <div className={styles.bar}>
            <span className={styles.title}>
              <Icon name="toolwindow-agents" size={14} />
              <span>{title}</span>
            </span>
            <IconButton icon="more-horizontal" title={tx("More")} size="small" disabled />
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.ideButton}
              onClick={() => setAgentMode(false)}
              {...tooltipAttrs(tx("Open in IDE"))}
            >
              IDE &#8599;
            </button>
            <IconButton icon="split" title={tx("Side by side")} size="small" disabled />
          </div>
          <div className={styles.body}>
            <div className={styles.narrow}>
              {homeOpen || !current ? (
                <HomeEditor />
              ) : (
                <SessionEditor
                  docked
                  input={{
                    kind: SESSION_KIND,
                    key: sessionKey(current.id),
                    data: { task: current.id, title: current.title },
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      <Rail />
    </div>
  );
}
