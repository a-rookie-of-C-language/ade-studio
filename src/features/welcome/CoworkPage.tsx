/** Task grouping helpers for the welcome home (also used by the workspace pill). */
import type { AgentTask } from "@/bindings";

/** Last path segment on either separator (tasks carry native paths like `D:\…`). */
export function projectName(path: string): string {
  const seg = path.split(/[/\\]/).pop() ?? "";
  return seg || path;
}

export interface TaskGroup {
  /** `projectRoot ?? cwd` of its tasks; "" when the task recorded neither. */
  key: string;
  items: AgentTask[];
}

/** Newest-first tasks (archived excluded), bucketed by project, groups newest-first. */
export function groupTasksByProject(all: Iterable<AgentTask>, limit = 30): TaskGroup[] {
  const tasks = [...all]
    .filter((task) => task.status !== "archived")
    .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0))
    .slice(0, limit);
  const byProject = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    const key = task.projectRoot ?? task.cwd ?? "";
    const list = byProject.get(key);
    if (list) list.push(task);
    else byProject.set(key, [task]);
  }
  // Each group's first item is its latest task, so this orders groups newest-first.
  return [...byProject.entries()]
    .sort((a, b) => (b[1][0]?.updatedMs ?? 0) - (a[1][0]?.updatedMs ?? 0))
    .map(([key, items]) => ({ key, items }));
}
