// Which toasts the trash button is allowed to clear.
//
// The pile is a "go check these" list, so the trash must never sweep away a task
// that is still working (running), still waiting on the user (needs_input) or has
// failed — clearing those loses the only reminder they exist. Only tasks that
// have arrived somewhere are dismissible: `done`, and `attention` (finished with
// something to read). Both are exactly the ones wearing the green pip, which is
// what the button promises visually.

import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";

const FINISHED_BUCKETS: ReadonlySet<WorkspaceStateBucket> = new Set<WorkspaceStateBucket>([
  "done",
  "attention",
]);

export function isFinishedToastBucket(bucket: WorkspaceStateBucket): boolean {
  return FINISHED_BUCKETS.has(bucket);
}

/**
 * Keys of the tracked toasts the trash button should clear, in the order given.
 * An empty result means the button has nothing to do and renders disabled.
 */
export function selectFinishedToastKeys(
  tasks: readonly { key: string; bucket: WorkspaceStateBucket }[],
): string[] {
  return tasks.filter((task) => isFinishedToastBucket(task.bucket)).map((task) => task.key);
}
