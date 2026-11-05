/** Agent-first home: one screen with the composer, workspaces and scheduled tasks. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT, useTx } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { HOME, focusComposer, openCoworkTask } from "@/features/agents/store";
import { stageLabel, useConnectDialog } from "@/features/remote-dev/model";
import {
  Icon,
  IconButton,
  Menu,
  ProgressBar,
  Sidebar,
  Spinner,
  useSidebar,
  type MenuItem,
  type SidebarSectionDef,
  T,
} from "@/ui";
import logo from "../../../src-tauri/icons/128x128.png";
import { CoworkHome, CoworkSoon, CoworkTasks } from "./CoworkPage";
import { ProjectsPage } from "./ProjectsPage";
import { loadRecent, useRecent } from "./recent";
import { useSession } from "./session";
import { dropWorkspace, RECENT_PREFIX, selectWorkspace, useWorkspace } from "./workspace";
import styles from "./Welcome.module.css";
import coworkStyles from "./Cowork.module.css";

export type WelcomePage = "cowork" | "projects" | "scheduled";

export const GEAR_MENU: MenuItem[] = [
  { kind: "action", action: "file.settings" },
  { kind: "action", action: "settings.keymap" },
  { kind: "action", action: "plugins.installFromDisk" },
  { kind: "separator" },
  { kind: "action", action: "help.keymapReference" },
  { kind: "action", action: "help.showLog" },
  { kind: "action", action: "app.checkForUpdates" },
  { kind: "separator" },
  { kind: "action", action: "app.about" },
];

function GearButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={ref}
        icon="settings"
        title="Manage"
        aria-haspopup="menu"
        aria-expanded={open}
        iconSize={16}
        className={styles.gear}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={GEAR_MENU}
        placement="top-start"
        aria-label="Manage"
      />
    </>
  );
}

/** Hides its content when the sidebar is collapsed to its icon rail. */
function ExpandedOnly({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return <>{children}</>;
}

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
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") return setOver(true);
          setOver(false);
          const { project, lightEdit } = useProject.getState();
          if (p.type === "drop" && p.paths.length && !project && !lightEdit)
            void dropWorkspace(p.paths).then((ok) => {
              if (ok) onWorkspace();
            });
        })
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        }),
    );
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
  const version = useRecent((s) => s.version);
  const recents = useRecent((s) => s.projects);
  const wsRoot = useWorkspace((s) => s.root);
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

  const contentLabel =
    page === "projects" ? t("cowork.projects") : page === "scheduled" ? t("cowork.scheduled") : t("cowork.cowork");

  const handleNav = (id: string) => {
    if (id.startsWith(RECENT_PREFIX)) {
      const path = id.slice(RECENT_PREFIX.length);
      if (recents.some((p) => p.path === path))
        void selectWorkspace(path).then((ok) => {
          if (ok) goHome();
        });
      return;
    }
    setPage(id as WelcomePage);
  };

  // The current workspace lights up in the rail; the default workspace has no row.
  const currentChild =
    wsRoot && recents.slice(0, 7).some((p) => p.path === wsRoot) ? `${RECENT_PREFIX}${wsRoot}` : null;
  const activeId = page === "cowork" && currentChild ? currentChild : page;

  const sections: SidebarSectionDef[] = [
    {
      items: [
        {
          id: "projects",
          label: t("cowork.projects"),
          icon: "folder",
          children: recents.slice(0, 7).map((p) => ({ id: `${RECENT_PREFIX}${p.path}`, label: p.name })),
        },
        { id: "scheduled", label: t("cowork.scheduled"), icon: "clock" },
      ],
    },
  ];

  return (
    <div className={styles.welcome}>
      <Sidebar
        sections={sections}
        activeId={activeId}
        onActiveChange={handleNav}
        navLabel={t("cowork.cowork")}
        collapseLabel={t("sidebar.collapse")}
        expandLabel={t("sidebar.expand")}
        storageKey="openidea.welcome.sidebar.collapsed"
        header={
          <>
            <div className={styles.brand}>
              <img className={styles.logo} src={logo} alt="" draggable={false} />
              <ExpandedOnly>
                <span className={styles.brandText}>
                  <span className={styles.appName}>{t("cowork.brand")}</span>
                  {version && <span className={styles.version}>{version}</span>}
                </span>
              </ExpandedOnly>
            </div>
            <ExpandedOnly>
              <button type="button" className={coworkStyles.newButton} onClick={goHome}>
                <Icon name="plus" size={16} />
                {t("cowork.new")}
              </button>
            </ExpandedOnly>
          </>
        }
        footer={<GearButton />}
      >
        <ExpandedOnly>
          <CoworkTasks
            onNewInProject={(path) => {
              void selectWorkspace(path).then((ok) => {
                if (ok) goHome();
              });
            }}
          />
        </ExpandedOnly>
      </Sidebar>
      <section className={styles.content} aria-label={contentLabel} aria-busy={opening || undefined}>
        {page === "cowork" && <CoworkHome />}
        {page === "scheduled" && (
          <CoworkSoon icon="clock" title={t("cowork.scheduled")} hint={t("cowork.soon.scheduled")} />
        )}
        {page === "projects" && <ProjectsPage onPick={goHome} />}
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
