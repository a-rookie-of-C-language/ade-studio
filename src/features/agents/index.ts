/**
 * Coding agents (Claude Code, Codex, Gemini CLI over ACP, run by `ide-agent`).
 *
 * Headless: the IDE shows no agent UI (no tool window, session tabs, shell,
 * menus or settings page) now that the welcome home embeds Cindy's own
 * interface. The backend keeps running tasks and mirroring them into the
 * store below; notifications and the title-bar pill read that state.
 */
import { useProject } from "@/platform/project";
import { connect, disconnect } from "./store";

export function activate(): () => void {
  // Cowork home has no explicit project, but the backend falls back to the
  // default workspace (`~/.openidea/workspace`), so always stay subscribed.
  const sync = () => {
    disconnect();
    void connect().catch((e: unknown) => console.warn("agents unavailable", e));
  };
  sync();
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root || s.project?.trusted !== prev.project?.trusted) sync();
  });
  return () => {
    offProject();
    disconnect();
  };
}
