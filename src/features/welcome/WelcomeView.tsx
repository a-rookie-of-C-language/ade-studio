/** Welcome home: Cindy's interface fills the window; the Projects page switches the agent workspace. */
import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useT, useTx } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { HOME, focusComposer, openCoworkTask } from "@/features/agents/store";
import { stageLabel, useConnectDialog } from "@/features/remote-dev/model";
import { Icon, ProgressBar, Spinner, T } from "@/ui";
import { CindyHome } from "./CindyHome";
import { ProjectsPage } from "./ProjectsPage";
import { loadRecent, useRecent } from "./recent";
import { useSession } from "./session";
import { dropWorkspace } from "./workspace";
import styles from "./Welcome.module.css";

export type WelcomePage = "cowork" | "projects";

/**
 * Paths dropped from the OS (Tauri drag-drop events carry real paths): folders
 * select the agent workspace, files open in LightEdit as before.
 */
function useFolderDrop(onWorkspace: () => void): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // Static import (not lazy): dynamic import() of Tauri APIs bypasses
    // vi.mock, so tests would load the real module and crash on
    // `window.__TAURI_INTERNALS__`. The module has no import-time side effects.
    void Promise.resolve()
      .then(() =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") return setOver(true);
          setOver(false);
          const { project, lightEdit } = useProject.getState();
          if (p.type === "drop" && p.paths.length && !project && !lightEdit)
            void dropWorkspace(p.paths).then((ok) => {
              if (ok) onWorkspace();
            });
        }),
      )
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onWorkspace]);
  return over;
}

/** A project opening at startup or in a new window; a remote one shows how far connecting is. */
function Reopening({ location }: { location: string }) {
  const tx = useTx();
  const progress = useRemoteProgress((s) => s.progress);
  const name = location.slice(location.lastIndexOf("/") + 1);
  const percent = progress?.fraction == null ? "" : ` ${Math.round(progress.fraction * 100)}%`;
  return (
    <div className={styles.reopening} role="status">
      <div className={styles.reopeningTitle}>
        <Spinner size={16} />
        <span>{tx`Opening ${name}…`}</span>
      </div>
      {progress && (
        <div className={styles.reopeningStage}>
          <span>{tx(stageLabel(progress.stage)) + percent}</span>
          <ProgressBar value={progress.fraction} aria-label={tx(stageLabel(progress.stage))} />
        </div>
      )}
    </div>
  );
}

export function WelcomeView() {
  const t = useT();
  const reopening = useSession((s) => s.reopening);
  // A remote project connecting with no dialog or list row to show it (a new window's).
  const connecting = useRemoteProgress((s) => s.location);
  const connectDialog = useConnectDialog((s) => s.open);
  const listOpening = useRecent((s) => s.opening);
  const opening = useProject((s) => s.opening);
  const [page, setPage] = useState<WelcomePage>("cowork");

  const goHome = () => {
    setPage("cowork");
    openCoworkTask(null);
    focusComposer(HOME);
  };
  const dropping = useFolderDrop(goHome);

  useEffect(() => {
    void loadRecent();
  }, []);

  if (reopening) return <Reopening location={reopening} />;
  if (connecting && !connectDialog && !listOpening) return <Reopening location={connecting} />;

  const contentLabel = page === "projects" ? t("cowork.projects") : t("cowork.cowork");

  return (
    <div className={styles.welcome}>
      <section className={styles.content} aria-label={contentLabel} aria-busy={opening || undefined}>
        {page === "cowork" ? (
          <CindyHome onOpenProjects={() => setPage("projects")} />
        ) : (
          <ProjectsPage onPick={goHome} />
        )}
        {dropping && (
          <div className={styles.dropOverlay} aria-hidden>
            <Icon name="folder-open" size={20} />
            <T>Drop a folder to use it as the agent workspace, or files to edit them</T>
          </div>
        )}
      </section>
    </div>
  );
}
