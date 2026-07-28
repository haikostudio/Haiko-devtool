import type { KanbanTask } from "@/data/tasks";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";

export interface PendingPublishCounts {
  /** Finished/queued cards whose work is not live yet. */
  pending: number;
  /** Of those, the ones whose publication will need a daemon restart. */
  needingRestart: number;
}

/**
 * Counts the finished-but-unpublished cards, and how many of them will need a
 * daemon restart. Pure, so the wording rule is unit-tested without a render.
 *
 * Archived cards are excluded: the user filed them away, so they must not keep
 * inflating a "still to publish" figure.
 */
export function countPendingPublish(tasks: readonly KanbanTask[]): PendingPublishCounts {
  let pending = 0;
  let needingRestart = 0;
  for (const task of tasks) {
    const finished = task.column === "done" || task.column === "deployed";
    if (!finished || task.archivedAt || isTaskDeployed(task)) {
      continue;
    }
    pending += 1;
    if (task.needsDaemonRestart === true) {
      needingRestart += 1;
    }
  }
  return { pending, needingRestart };
}
