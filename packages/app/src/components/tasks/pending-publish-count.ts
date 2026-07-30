import type { KanbanTask } from "@/data/tasks";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";

export interface PendingPublishCounts {
  /** Finished/queued cards whose work is not live yet. */
  pending: number;
}

/**
 * Counts the finished-but-unpublished cards. Pure, so the wording rule is
 * unit-tested without a render.
 *
 * It used to also count "how many of these need a daemon restart". That clause is
 * gone: a publication now restarts the engine every time, so splitting the figure
 * only invited the reader to wonder which half would take effect.
 *
 * Archived cards are excluded: the user filed them away, so they must not keep
 * inflating a "still to publish" figure.
 */
export function countPendingPublish(tasks: readonly KanbanTask[]): PendingPublishCounts {
  let pending = 0;
  for (const task of tasks) {
    const finished = task.column === "done" || task.column === "deployed";
    if (!finished || task.archivedAt || isTaskDeployed(task)) {
      continue;
    }
    pending += 1;
  }
  return { pending };
}
