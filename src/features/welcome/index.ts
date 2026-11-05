/** Welcome screen, recent projects (File › Open Recent) and reopening the last project on startup. */
import { registerActions } from "@/platform/actions";
import { provideProjectPopup, provideWelcomeView, registerOverlay } from "@/workbench/contributions";
import { ProjectPopup } from "./ProjectPopup";
import { RecentProjectsPopup, showRecentProjectsPopup } from "./RecentProjectsPopup";
import { reopenLastProject, trackSession } from "./session";
import { WelcomeView } from "./WelcomeView";
import { openCurrentWorkspaceInIDE, openWorkspaceInIDE } from "./workspace";

export function activate(): () => void {
  const disposers = [
    trackSession(),
    provideWelcomeView(WelcomeView),
    provideProjectPopup(ProjectPopup),
    registerOverlay({ id: "welcome.recentProjects", component: RecentProjectsPopup }),
    registerActions([
      {
        id: "welcome.openInIDE",
        title: "Open in IDE",
        category: "File",
        icon: "open-in-tool-window",
        keywords: ["ide", "open project", "agent panel"],
        run: ({ arg }) => void (typeof arg === "string" && arg ? openWorkspaceInIDE(arg) : openCurrentWorkspaceInIDE()),
      },
      {
        id: "welcome.recentProjects",
        title: "Recent Projects…",
        category: "File",
        icon: "history",
        keywords: ["open recent", "projects"],
        run: showRecentProjectsPopup,
      },
      {
        id: "file.openRecent",
        title: "Open Recent…",
        category: "File",
        icon: "history",
        keywords: ["recent projects", "reopen"],
        run: showRecentProjectsPopup,
      },
    ]),
  ];
  void reopenLastProject();
  return () => disposers.reverse().forEach((d) => d());
}
