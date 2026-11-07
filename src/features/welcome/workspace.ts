/** The agent workspace of the welcome home: the folder tasks run in. */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { call, commands, isCancelled, isTauri, type TrustStatus } from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { invokeLocal } from "@/platform/tauriCore";
import { confirmProjectTrust } from "@/platform/projectTrust";
import { parseRemoteLocation } from "@/platform/remote";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { openRecent, removeRecent } from "./recent";

const STORAGE_KEY = "openidea.workspace.root";

interface WorkspaceState {
  /** Selected workspace folder; `null` is the default (`~/.openidea/workspace`). */
  root: string | null;
}

function load(): string | null {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as string | null) : null;
  } catch {
    return null;
  }
}

/** The agent workspace: where the home composer runs tasks. `null` is the default workspace. */
export const useWorkspace = create<WorkspaceState>(() => ({ root: load() }));

useWorkspace.subscribe((s) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s.root));
  } catch {
    /* private mode: keep the in-memory state */
  }
});

/** Back to the default workspace (`~/.openidea/workspace`). */
export function clearWorkspace() {
  useWorkspace.setState({ root: null });
}

/** Where the home terminal runs: the picked workspace, else the default one. */
export async function resolveHomeCwd(): Promise<string | null> {
  const picked = useWorkspace.getState().root;
  if (picked) return picked;
  if (!isTauri()) return null;
  const home = await import("@tauri-apps/api/path").then((m) => m.homeDir()).catch(() => null);
  if (!home) return null;
  return `${home.replace(/\/+$/, "")}/.openidea/workspace`;
}

/**
 * Makes sure the home terminal has a directory to start in (a fresh install
 * has no default workspace yet). Best effort: a lost race reads as missing.
 */
export async function ensureHomeCwd(cwd: string): Promise<boolean> {
  const exists = await call(commands.fsReadDir(cwd)).then(
    () => true,
    () => false,
  );
  if (exists) return true;
  return call(commands.fsCreateDir(cwd)).then(
    () => true,
    () => false,
  );
}

const desktopOnly = () =>
  notifications().notify({
    level: "warning",
    title: tx("Selecting a workspace requires the desktop app"),
    body: tx("Run `pnpm tauri dev` to use the file system."),
  });

/**
 * Points the agent workspace at `path` (staying on the home screen, no IDE).
 * Trust is confirmed first; untrusted and remote folders are refused.
 */
export async function selectWorkspace(path: string): Promise<boolean> {
  if (!isTauri()) {
    desktopOnly();
    return false;
  }
  if (parseRemoteLocation(path)) {
    notifications().notify({
      level: "warning",
      title: tx("Remote workspaces need the IDE"),
      body: tx("Open this project in the IDE to work with it."),
    });
    return false;
  }
  const isDir = await call(commands.fsReadDir(path)).then(
    () => true,
    () => false,
  );
  if (!isDir) {
    notifications().notify({
      level: "error",
      title: tx("Project folder not found"),
      body: path,
      key: `workspace.select:${path}`,
      actions: [{ label: tx("Remove from Recent Projects"), run: () => void removeRecent(path) }],
    });
    return false;
  }
  try {
    await confirmProjectTrust(path, "local");
  } catch (e) {
    if (!isCancelled(e)) {
      notifications().notify({
        level: "error",
        title: tx("Cannot select workspace"),
        body: e instanceof Error ? e.message : String(e),
      });
    }
    return false;
  }
  const status = await invokeLocal<TrustStatus>("project_trust_status", { path }).catch(() => null);
  if (status && !status.trusted) {
    notifications().notify({
      level: "warning",
      title: tx("Folder is in Restricted Mode"),
      body: tx("Trust this folder to run agents in it."),
      key: `workspace.restricted:${path}`,
    });
    return false;
  }
  // Best effort: the folder is usable even when the recents update fails.
  await call(commands.touchRecentProject(path)).catch((e: unknown) => console.warn("touch recent workspace failed", e));
  useWorkspace.setState({ root: path });
  return true;
}

/** Folder dialog for a new workspace; selecting it points the workspace there. */
export async function openWorkspaceDialog(): Promise<boolean> {
  if (!isTauri()) {
    desktopOnly();
    return false;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Open Folder" });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return false;
  return selectWorkspace(path);
}

/** Drops from the OS: folders select the workspace, files open as before. */
export async function dropWorkspace(paths: readonly string[]): Promise<boolean> {
  const kinds = await Promise.all(
    paths.map((p) =>
      call(commands.fsReadDir(p)).then(
        () => true,
        () => false,
      ),
    ),
  );
  const dir = paths.find((_, i) => kinds[i]);
  const files = paths.filter((_, i) => !kinds[i]);
  if (files.length) void executeAction("file.openPaths", files);
  if (!dir) return false;
  return selectWorkspace(dir);
}

/**
 * Opens `path` as an IDE project in this window and reveals the Agents panel
 * on the right. A remote project opens in a new window instead: still true,
 * without revealing anything here.
 */
export async function openWorkspaceInIDE(path: string, name?: string): Promise<boolean> {
  if (!isTauri()) {
    desktopOnly();
    return false;
  }
  const ok = await openRecent({ path, name: name ?? basename(path) });
  if (!ok) return false;
  if (useProject.getState().project?.root !== path) return true;
  await executeAction("agents.showToolWindow");
  return true;
}

/** IDE switch for the current agent workspace (picked or default). */
export async function openCurrentWorkspaceInIDE(): Promise<boolean> {
  if (!isTauri()) {
    desktopOnly();
    return false;
  }
  const picked = useWorkspace.getState().root;
  const target = picked ?? (await resolveHomeCwd());
  if (!target) return false;
  return openWorkspaceInIDE(target);
}
