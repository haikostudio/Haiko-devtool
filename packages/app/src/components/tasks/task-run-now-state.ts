import type { KanbanTask } from "@/data/tasks";

/**
 * What the run-now control should say and whether it may be pressed. Derived
 * purely from the card's own schedule state (the daemon's truth) plus the local
 * optimistic press, so the control can never claim something the board does not.
 *
 * Kept out of the component — same reason as getScheduleBadge — so the branch
 * count stays off the render function and every state is testable without the
 * React Native render tree.
 */
export interface RunNowState {
  labelKey: string;
  /** Spinner instead of an icon, and the press is refused (already launching). */
  busy: boolean;
  /** A previous launch failed: offer a retry affordance instead of "play". */
  retry: boolean;
}

export function resolveRunNowState(
  schedule: KanbanTask["schedule"],
  pending: boolean,
): RunNowState {
  // A launch the daemon has taken charge of, or one we just asked for and are
  // still waiting to see land: the only state where pressing again is refused.
  if (pending || schedule?.state === "launching" || schedule?.state === "running") {
    return { labelKey: "tasks.panel.runNowLaunching", busy: true, retry: false };
  }
  // Attempts exhausted. The card will not move on its own any more, so the
  // control has to say so AND stay pressable — run-now re-arms the schedule
  // server-side (attempts reset, recorded error cleared), which is the only way
  // out. A silent, inert button here was the whole complaint.
  if (schedule?.state === "failed") {
    return { labelKey: "tasks.panel.runNowFailed", busy: false, retry: true };
  }
  // Analysis has not produced an estimate yet, so nothing can launch. Still
  // pressable: run-now re-requests the estimate.
  if (schedule?.state === "pending_estimate") {
    return { labelKey: "tasks.panel.runNowEstimating", busy: false, retry: false };
  }
  // Queued and explicitly held back. Run-now is precisely the override, so name
  // the reason and keep the action inviting.
  if (schedule?.waitingReason === "quota") {
    return { labelKey: "tasks.panel.runNowWaitingQuota", busy: false, retry: false };
  }
  if (schedule?.waitingReason === "quiet_hours") {
    return { labelKey: "tasks.panel.runNowWaitingWindow", busy: false, retry: false };
  }
  return { labelKey: "tasks.actions.runNow", busy: false, retry: false };
}
