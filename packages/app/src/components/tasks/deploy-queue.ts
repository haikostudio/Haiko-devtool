import type { KanbanTask } from "@/data/tasks";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";

// Pure queue predicates for the "À déployer" column, kept free of any view
// imports so they stay testable in the plain node unit environment (the button
// itself pulls in the dropdown-menu stack, which that environment can't load).

/**
 * The cards a press would actually take online, so the "(N)" on the button
 * matches what the batch publishes. Mirrors the server's `selectPendingDeployTasks`
 * exactly: in the "À déployer" queue, not archived, not held back from the next
 * batch ("Retirer du prochain lot"), and not live yet. Held or already-live cards
 * stay visible in the column but the run skips them, so they must not inflate the
 * count — otherwise the button promises to publish more than it will.
 */
export function countTasksAwaitingDeploy(tasks: readonly KanbanTask[]): number {
  return tasks.filter(
    (task) =>
      task.column === "deployed" &&
      !task.archivedAt &&
      task.deployHold !== true &&
      !isTaskDeployed(task),
  ).length;
}

/**
 * The finished cards resting in "Terminé" that nobody has queued yet — the work
 * that is done and going nowhere until the user presses "Mettre dans À déployer".
 *
 * A finished card stops in "Terminé" on purpose (the daemon no longer queues it
 * on its own), which means the column quietly accumulates: without a figure on
 * the header, three finished cards waiting to be published look exactly like an
 * empty board. Archived cards are excluded — filing one away IS the decision not
 * to publish it.
 */
export function countTasksAwaitingQueue(tasks: readonly KanbanTask[]): number {
  return tasks.filter((task) => task.column === "done" && !task.archivedAt).length;
}

/** True while the batch publication is running on at least one of these cards. */
export function isDeployAllRunning(tasks: readonly KanbanTask[]): boolean {
  return tasks.some((task) => task.deployment?.state === "running");
}
