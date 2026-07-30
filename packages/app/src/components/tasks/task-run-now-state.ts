import type { KanbanTask } from "@/data/tasks";

/**
 * What the run-now control should say, show and accept. Derived purely from the
 * card's own schedule state (the daemon's truth) plus the local optimistic press,
 * so the control can never claim something the board does not.
 *
 * Kept out of the component — same reason as getScheduleBadge — so the branch
 * count stays off the render function and every state is testable without the
 * React Native render tree.
 */
export interface RunNowState {
  labelKey: string;
  /** Show a spinner instead of an icon: a launch is under way. */
  busy: boolean;
  /**
   * Refuse the press. Deliberately NARROWER than `busy`, and driven only by the
   * local optimistic press — never by a daemon state.
   *
   * A daemon state must never latch this control off. `schedule.state` can stay
   * "launching" indefinitely when a launch dies mid-flight (daemon restarted
   * between reserving the slot and spawning the agent), and re-pressing run-now
   * is precisely what re-arms such a card server-side. Disabling on "launching"
   * would put the only cure behind the disease — the stuck button all over
   * again. So a stalled launch still SHOWS as busy, but stays pressable.
   *
   * Double-launching is prevented without it: this flag covers the double-tap
   * window (it clears itself on a timer), and the scheduler's own in-flight set
   * skips a task whose launch is genuinely running.
   */
  disabled: boolean;
  /** A previous launch failed: offer a retry affordance instead of "play". */
  retry: boolean;
}

export function resolveRunNowState(
  schedule: KanbanTask["schedule"],
  pending: boolean,
): RunNowState {
  // A launch the daemon has taken charge of, or one we just asked for and are
  // still waiting to see land. Only the local press refuses a second one.
  if (pending || schedule?.state === "launching" || schedule?.state === "running") {
    return {
      labelKey: "tasks.panel.runNowLaunching",
      busy: true,
      disabled: pending,
      retry: false,
    };
  }
  // Attempts exhausted. The card will not move on its own any more, so the
  // control has to say so AND stay pressable — run-now re-arms the schedule
  // server-side (attempts reset, recorded error cleared), which is the only way
  // out. A silent, inert button here was the whole complaint.
  if (schedule?.state === "failed") {
    return {
      labelKey: "tasks.panel.runNowFailed",
      busy: false,
      disabled: false,
      retry: true,
    };
  }
  // Analysis has not produced an estimate yet, so nothing can launch. Still
  // pressable: run-now re-requests the estimate.
  if (schedule?.state === "pending_estimate") {
    return {
      labelKey: "tasks.panel.runNowEstimating",
      busy: false,
      disabled: false,
      retry: false,
    };
  }
  // Queued and explicitly held back. Run-now is precisely the override, so name
  // the reason and keep the action inviting.
  if (schedule?.waitingReason === "quota") {
    return {
      labelKey: "tasks.panel.runNowWaitingQuota",
      busy: false,
      disabled: false,
      retry: false,
    };
  }
  if (schedule?.waitingReason === "quiet_hours") {
    return {
      labelKey: "tasks.panel.runNowWaitingWindow",
      busy: false,
      disabled: false,
      retry: false,
    };
  }
  // Run-now overrides the timing gates, but NOT the two physical ones: a sibling
  // task holding the shared worktree, and a full set of launch slots. Pressing
  // again cannot help, so the control names the hold instead of pretending the
  // press was ignored.
  if (schedule?.waitingBlocker === "shared_worktree") {
    return {
      labelKey: "tasks.panel.runNowWaitingSibling",
      busy: false,
      disabled: false,
      retry: false,
    };
  }
  if (schedule?.waitingBlocker === "slots_busy") {
    return {
      labelKey: "tasks.panel.runNowWaitingSlot",
      busy: false,
      disabled: false,
      retry: false,
    };
  }
  return { labelKey: "tasks.actions.runNow", busy: false, disabled: false, retry: false };
}
