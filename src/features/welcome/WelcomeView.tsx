/** Agent-first welcome: Cowork home by default, classic Code (projects) one tab away. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useT, useTx, tx } from "@/platform/i18n";
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
import { useSettingsPages } from "@/workbench/contributions";
import { ErrorBoundary, Slot } from "@/workbench/ErrorBoundary";
import logo from "../../../src-tauri/icons/128x128.png";
import { CoworkHome, CoworkSoon, CoworkTasks } from "./CoworkPage";
import { CustomizePage } from "./CustomizePage";
import { ProjectsPage } from "./ProjectsPage";
import { loadRecent, openRecent, useRecent } from "./recent";
import { useSession } from "./session";
import styles from "./Welcome.module.css";
import coworkStyles from "./Cowork.module.css";

export type WelcomePage = "cowork" | "projects" | "customize" | "plugins" | "artifacts" | "scheduled";
/** Sidebar mode: agent-first home, or the classic project list. */
export type WelcomeMode = "cowork" | "code";

/** Settings page id contributed by the plugins feature (embedded as Welcome › Plugins). */
const PLUGINS_PAGE = "plugins";

/** Sidebar child id for a recent workspace. */
const RECENT_PREFIX = "recent:";

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
 * Paths dropped from the OS (Tauri drag-drop events carry real paths): a folder opens
 * as a project, files open in LightEdit.
 */
function useFolderDrop(): boolean {
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
            void executeAction("file.openPaths", p.paths);
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
  }, []);
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
  const reopening = useSession((s) => s.reopening);
  // A remote project connecting with no dialog or list row to show it (a new window's).
  const connecting = useRemoteProgress((s) => s.location);
  const connectDialog = useConnectDialog((s) => s.open);
  const listOpening = useRecent((s) => s.opening);
  const opening = useProject((s) => s.opening);
  const Plugins = useSettingsPages((s) => s.pages.get(PLUGINS_PAGE)?.component);
  const [mode, setMode] = useState<WelcomeMode>("cowork");
  const [page, setPage] = useState<WelcomePage>("cowork");
  const dropping = useFolderDrop();
  const shown = page === "plugins" && !Plugins ? (mode === "code" ? "projects" : "cowork") : page;

  useEffect(() => {
    void loadRecent();
  }, []);

  if (reopening) return <Reopening location={reopening} />;
  if (connecting && !connectDialog && !listOpening) return <Reopening location={connecting} />;

  const goCode = () => {
    setMode("code");
    setPage("projects");
  };
  const goCowork = () => {
    setMode("cowork");
    setPage("cowork");
  };
  const contentLabel =
    shown === "projects"
      ? t("cowork.projects")
      : shown === "customize"
        ? t("cowork.customize")
        : shown === "scheduled"
          ? t("cowork.scheduled")
          : shown === "plugins"
            ? "Plugins"
            : t("cowork.cowork");

  const handleNav = (id: string) => {
    if (id.startsWith(RECENT_PREFIX)) {
      const path = id.slice(RECENT_PREFIX.length);
      const found = recents.find((p) => p.path === path);
      if (found) void openRecent(found);
      return;
    }
    setPage(id as WelcomePage);
  };

  const sections: SidebarSectionDef[] =
    mode === "cowork"
      ? [
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
        ]
      : [
          {
            items: [
              { id: "projects", label: "Projects" },
              { id: "customize", label: "Customize" },
              ...(Plugins ? [{ id: "plugins" as const, label: "Plugins" }] : []),
            ],
          },
        ];

  return (
    <div className={styles.welcome}>
      <Sidebar
        sections={sections}
        activeId={shown}
        onActiveChange={handleNav}
        navLabel={mode === "cowork" ? t("cowork.cowork") : tx("Welcome")}
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
              <div className={coworkStyles.modeTabs} role="tablist" aria-label={t("cowork.mode")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "cowork"}
                  className={coworkStyles.modeTab}
                  onClick={goCowork}
                >
                  {t("cowork.cowork")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "code"}
                  className={coworkStyles.modeTab}
                  onClick={goCode}
                >
                  {t("cowork.code")}
                </button>
              </div>
            </ExpandedOnly>
            {mode === "code" ? (
              <p className={styles.tagline}>{t("app.about.tagline")}</p>
            ) : (
              <ExpandedOnly>
                <button
                  type="button"
                  className={coworkStyles.newButton}
                  onClick={() => {
                    setPage("cowork");
                    openCoworkTask(null);
                    focusComposer(HOME);
                  }}
                >
                  <Icon name="plus" size={16} />
                  {t("cowork.new")}
                </button>
              </ExpandedOnly>
            )}
          </>
        }
        footer={<GearButton />}
      >
        {mode === "cowork" && (
          <ExpandedOnly>
            <CoworkTasks />
          </ExpandedOnly>
        )}
      </Sidebar>
      <section
        className={clsx(styles.content, shown === "plugins" && styles.contentPlugins)}
        aria-label={contentLabel}
        aria-busy={opening || undefined}
      >
        {shown === "cowork" && <CoworkHome />}
        {shown === "scheduled" && (
          <CoworkSoon icon="clock" title={t("cowork.scheduled")} hint={t("cowork.soon.scheduled")} />
        )}
        {shown === "projects" && <ProjectsPage />}
        {shown === "customize" && <CustomizePage />}
        {shown === "plugins" && Plugins && (
          <ErrorBoundary name="welcome plugins page">
            <Slot component={Plugins} />
          </ErrorBoundary>
        )}
        {dropping && (
          <div className={styles.dropOverlay} aria-hidden>
            <Icon name="folder-open" size={20} />
            <T>Drop a folder to open it as a project, or files to edit them</T>
          </div>
        )}
      </section>
    </div>
  );
}
