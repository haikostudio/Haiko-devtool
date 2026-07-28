import type { KanbanTask } from "@/data/tasks";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";

// Pure queue predicates for the "À déployer" column, kept free of any view
// imports so they stay testable in the plain node unit environment (the button
// itself pulls in the dropdown-menu stack, which that environment can't load).

/** The cards a press would take online: queued, not archived, not live yet. */
export function countTasksAwaitingDeploy(tasks: readonly KanbanTask[]): number {
  return tasks.filter((task) => !task.archivedAt && !isTaskDeployed(task)).length;
}

/** True while the batch publication is running on at least one of these cards. */
export function isDeployAllRunning(tasks: readonly KanbanTask[]): boolean {
  return tasks.some((task) => task.deployment?.state === "running");
}
