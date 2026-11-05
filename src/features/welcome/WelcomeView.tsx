/** Agent-first welcome: Cowork home by default, classic Code (projects) one tab away. */
import { useEffect, useRef, useState, type ComponentProps } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useT, useTx, tx } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { HOME, focusComposer } from "@/features/agents/store";
import { stageLabel, useConnectDialog } from "@/features/remote-dev/model";
import { Icon, IconButton, Menu, ProgressBar, Spinner, type MenuItem, T } from "@/ui";
import { useSettingsPages } from "@/workbench/contributions";
import { ErrorBoundary, Slot } from "@/workbench/ErrorBoundary";
import logo from "../../../src-tauri/icons/128x128.png";
import { CoworkHome, CoworkSoon, CoworkTasks } from "./CoworkPage";
import { CustomizePage } from "./CustomizePage";
import { ProjectsPage } from "./ProjectsPage";
import { loadRecent, useRecent } from "./recent";
import { useSession } from "./session";
import styles from "./Welcome.module.css";
import coworkStyles from "./Cowork.module.css";

export type WelcomePage = "cowork" | "projects" | "customize" | "plugins" | "artifacts" | "scheduled";
/** Sidebar mode: agent-first home, or the classic project list. */
export type WelcomeMode = "cowork" | "code";

/** Settings page id contributed by the plugins feature (embedded as Welcome › Plugins). */
const PLUGINS_PAGE = "plugins";

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

function NavItem({
  id,
  label,
  icon,
  page,
  onSelect,
}: {
  id: WelcomePage;
  label: string;
  icon?: ComponentProps<typeof Icon>["name"];
  page: WelcomePage;
  onSelect: (p: WelcomePage) => void;
}) {
  return (
    <button
      type="button"
      className={styles.navItem}
      aria-current={page === id ? "page" : undefined}
      onClick={() => onSelect(id)}
    >
      {icon && <Icon name={icon} size={16} className={coworkStyles.sideIcon} />}
      {label}
    </button>
  );
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
  /** Cowork rail: Projects jumps to the Code list, the rest are cowork pages. */
  const selectCowork = (p: WelcomePage) => {
    if (p === "projects") return goCode();
    setPage(p);
  };
  const contentLabel =
    shown === "projects"
      ? t("cowork.projects")
      : shown === "customize"
        ? t("cowork.customize")
        : shown === "artifacts"
          ? t("cowork.artifacts")
          : shown === "scheduled"
            ? t("cowork.scheduled")
            : shown === "plugins"
              ? "Plugins"
              : t("cowork.cowork");

  return (
    <div className={styles.welcome}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <img className={styles.logo} src={logo} alt="" draggable={false} />
          <span className={styles.brandText}>
            <span className={styles.appName}>{t("cowork.brand")}</span>
            {version && <span className={styles.version}>{version}</span>}
          </span>
        </div>
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
        {mode === "cowork" ? (
          <>
            <button
              type="button"
              className={coworkStyles.newButton}
              onClick={() => {
                setPage("cowork");
                focusComposer(HOME);
              }}
            >
              <Icon name="plus" size={16} />
              {t("cowork.new")}
            </button>
            <nav className={styles.nav} aria-label={t("cowork.cowork")}>
              <NavItem id="projects" label={t("cowork.projects")} icon="folder" page={shown} onSelect={selectCowork} />
              <NavItem
                id="artifacts"
                label={t("cowork.artifacts")}
                icon="package"
                page={shown}
                onSelect={selectCowork}
              />
              <NavItem id="scheduled" label={t("cowork.scheduled")} icon="clock" page={shown} onSelect={selectCowork} />
              <NavItem
                id="customize"
                label={t("cowork.customize")}
                icon="sliders"
                page={shown}
                onSelect={selectCowork}
              />
            </nav>
            <CoworkTasks />
          </>
        ) : (
          <>
            <p className={styles.tagline}>{t("app.about.tagline")}</p>
            <nav className={styles.nav} aria-label={tx("Welcome")}>
              <NavItem id="projects" label="Projects" page={shown} onSelect={setPage} />
              <NavItem id="customize" label="Customize" page={shown} onSelect={setPage} />
              {Plugins && <NavItem id="plugins" label="Plugins" page={shown} onSelect={setPage} />}
            </nav>
          </>
        )}
        <div className={styles.sidebarSpacer} />
        <div className={styles.sidebarFooter}>
          <GearButton />
        </div>
      </aside>
      <section
        className={clsx(styles.content, shown === "plugins" && styles.contentPlugins)}
        aria-label={contentLabel}
        aria-busy={opening || undefined}
      >
        {shown === "cowork" && <CoworkHome />}
        {shown === "artifacts" && (
          <CoworkSoon icon="package" title={t("cowork.artifacts")} hint={t("cowork.soon.artifacts")} />
        )}
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
