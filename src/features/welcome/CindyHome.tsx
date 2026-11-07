/** Cowork center: the embedded Cindy interface, with the workspace switcher, IDE jump and terminal drawer. */
import { useT } from "@/platform/i18n";
import { CindyView } from "@/features/cindy/CindyView";
import { projectName } from "./CoworkPage";
import { Icon, T } from "@/ui";
import { HomeTerminalPanel, useHomeTerminal } from "./HomeTerminal";
import { openCurrentWorkspaceInIDE, useWorkspace } from "./workspace";
import styles from "./CindyHome.module.css";

/** Top-right cluster: the agent workspace (opens the switcher) and the IDE jump. */
function TopRight({ onOpenProjects }: { onOpenProjects: () => void }) {
  const t = useT();
  const wsRoot = useWorkspace((s) => s.root);
  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={styles.jump}
        title={t("cowork.projects")}
        aria-label={t("cowork.projects")}
        onClick={onOpenProjects}
      >
        <Icon name="folder" size={14} />
        <span className={styles.jumpName}>{wsRoot ? projectName(wsRoot) : <T>Default workspace</T>}</span>
      </button>
      <button
        type="button"
        className={styles.jump}
        onClick={() => void openCurrentWorkspaceInIDE()}
        title={t("cowork.openIDE")}
      >
        <span>IDE</span>
        <Icon name="open-in-tool-window" size={14} />
      </button>
    </div>
  );
}

export function CindyHome({ onOpenProjects }: { onOpenProjects: () => void }) {
  const terminalOpen = useHomeTerminal((s) => s.open);
  const setTerminalOpen = useHomeTerminal((s) => s.setOpen);
  return (
    <div className={styles.home}>
      <TopRight onOpenProjects={onOpenProjects} />
      <div className={styles.frame}>
        <CindyView />
      </div>
      {terminalOpen && <HomeTerminalPanel onClose={() => setTerminalOpen(false)} />}
    </div>
  );
}
