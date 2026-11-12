import { Icon, T } from "@/ui";
import { DEMO_TASKS } from "./model";
import { openAgentCenter, useAgentCenter } from "./store";
import styles from "./AgentCenter.module.css";

export function AgentCenterTitleItem() {
  const open = useAgentCenter((state) => state.open);
  const attention = DEMO_TASKS.filter((task) => task.status === "needs-input").length;

  return (
    <button
      type="button"
      className={styles.titleItem}
      title="Agent Center"
      aria-expanded={open}
      onClick={openAgentCenter}
    >
      <span className={styles.titleIcon} aria-hidden="true">
        <Icon name="toolwindow-pull-requests" size={16} />
      </span>
      <span className={styles.titleLabel}>
        <T>Agent Center</T>
      </span>
      {attention > 0 && (
        <span className={styles.titleBadge} aria-hidden="true">
          {attention}
        </span>
      )}
    </button>
  );
}
