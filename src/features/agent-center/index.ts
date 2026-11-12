import { registerActions } from "@/platform/actions";
import { registerOverlay, registerTitleItem } from "@/workbench/contributions";
import { AgentCenterOverlay } from "./AgentCenter";
import { AgentCenterTitleItem } from "./AgentCenterTitleItem";
import { openAgentCenter } from "./store";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "agent.center", component: AgentCenterOverlay }),
    registerTitleItem({
      id: "agent.center.title",
      title: "Agent Center",
      align: "right",
      priority: -2,
      component: AgentCenterTitleItem,
    }),
    registerActions([
      {
        id: "agent.center.open",
        title: "Agent Center",
        description: "Review agent tasks across every open project",
        category: "Agent",
        icon: "toolwindow-pull-requests",
        keywords: ["agents", "tasks", "review", "worktree", "parallel", "inbox"],
        run: openAgentCenter,
      },
    ]),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
