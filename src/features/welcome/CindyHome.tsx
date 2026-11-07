/** Cowork center: the embedded Cindy interface, with the IDE jump and the terminal drawer. */
import { useT } from "@/platform/i18n";
import { CindyView } from "@/features/cindy/CindyView";
import { Icon } from "@/ui";
import { HomeTerminalPanel, useHomeTerminal } from "./HomeTerminal";
import { openCurrentWorkspaceInIDE } from "./workspace";
import coworkStyles from "./Cowork.module.css";
import styles from "./CindyHome.module.css";

/** Top-right jump to the IDE for the current workspace, like TRAE's home. */
function IdeJump() {
  const t = useT();
  return (
    <button
      type="button"
      className={coworkStyles.ideJump}
      onClick={() => void openCurrentWorkspaceInIDE()}
      title={t("cowork.openIDE")}
    >
      <span>IDE</span>
      <Icon name="open-in-tool-window" size={14} />
    </button>
  );
}

export function CindyHome() {
  const terminalOpen = useHomeTerminal((s) => s.open);
  const setTerminalOpen = useHomeTerminal((s) => s.setOpen);
  return (
    <div className={styles.home}>
      <IdeJump />
      <div className={styles.frame}>
        <CindyView />
      </div>
      {terminalOpen && <HomeTerminalPanel onClose={() => setTerminalOpen(false)} />}
    </div>
  );
}
