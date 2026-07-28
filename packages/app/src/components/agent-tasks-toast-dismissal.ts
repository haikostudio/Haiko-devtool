// What the toast pile's trash button is allowed to clear, and when a card clears
// itself.
//
// The pile is a "go check these" list, so the trash must never sweep away a task
// that is still working (running). Everything else can be cleared, but only
// deliberately: the plain click clears the *finished* cards (the green pips —
// `done` and `attention`), and the category menu is what lets the user drop the
// failed or waiting ones once they've read them.
//
// Keeping the rules here (rather than inline in the components) means the desktop
// pile and the mobile drawer can't drift apart, and every rule is unit-testable
// without mounting a view.

import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";

/** How long the "undo" affordance stays offered after a clear. */
export const TOAST_UNDO_WINDOW_MS = 3_000;

/**
 * How long a finished card lingers before the pile tidies it away on its own.
 * Long enough that a task you finished reading about is still there when you
 * glance back, short enough that a busy morning doesn't leave a wall of green.
 * Only ever applies to finished cards — running, waiting and failed ones stay
 * until the user deals with them.
 */
export const AUTO_DISMISS_FINISHED_MS = 10 * 60_000;

/** The clearable groups, in the order the category menu lists them. */
export type ToastClearCategory = "finished" | "failed" | "needsInput";

export const TOAST_CLEAR_CATEGORIES: readonly ToastClearCategory[] = [
  "finished",
  "failed",
  "needsInput",
];

// `running` is deliberately absent from every category: a task still in flight is
// never clearable, by any route.
const BUCKETS_BY_CATEGORY: Record<ToastClearCategory, ReadonlySet<WorkspaceStateBucket>> = {
  finished: new Set<WorkspaceStateBucket>(["done", "attention"]),
  failed: new Set<WorkspaceStateBucket>(["failed"]),
  needsInput: new Set<WorkspaceStateBucket>(["needs_input"]),
};

export interface ClearableToast {
  key: string;
  bucket: WorkspaceStateBucket;
}

export function isFinishedToastBucket(bucket: WorkspaceStateBucket): boolean {
  return BUCKETS_BY_CATEGORY.finished.has(bucket);
}

/**
 * Keys of the tracked toasts the trash button should clear, in the order given.
 * An empty result means the button has nothing to do and renders disabled.
 */
export function selectFinishedToastKeys(tasks: readonly ClearableToast[]): string[] {
  return selectToastKeysForCategory(tasks, "finished");
}

/** Keys belonging to one clearable category, in the order given. */
export function selectToastKeysForCategory(
  tasks: readonly ClearableToast[],
  category: ToastClearCategory,
): string[] {
  const buckets = BUCKETS_BY_CATEGORY[category];
  return tasks.filter((task) => buckets.has(task.bucket)).map((task) => task.key);
}

/** How many cards each category would clear — drives the badge and the menu. */
export function countToastsByCategory(
  tasks: readonly ClearableToast[],
): Record<ToastClearCategory, number> {
  const counts: Record<ToastClearCategory, number> = { finished: 0, failed: 0, needsInput: 0 };
  for (const task of tasks) {
    for (const category of TOAST_CLEAR_CATEGORIES) {
      if (BUCKETS_BY_CATEGORY[category].has(task.bucket)) {
        counts[category] += 1;
      }
    }
  }
  return counts;
}

/**
 * Finished cards whose lingering time is up. `finishedSince` maps a tracked key
 * to the moment it *became* finished (the store keeps that clock; undoing a clear
 * restarts it), so a card only ages out once it has actually sat there.
 */
export function selectAutoDismissibleKeys(
  finishedSince: ReadonlyMap<string, number>,
  now: number,
  delayMs: number = AUTO_DISMISS_FINISHED_MS,
): string[] {
  const due: string[] = [];
  for (const [key, since] of finishedSince) {
    if (now - since >= delayMs) {
      due.push(key);
    }
  }
  return due;
}
