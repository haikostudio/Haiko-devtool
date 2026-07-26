import type { KanbanTask } from "@/data/tasks";
import type { TaskTone } from "@/components/tasks/task-status-tone";

export type ScheduleBadgeVariant = "success" | "error" | "warning";

export interface ScheduleBadgeDescriptor {
  labelKey: string;
  variant?: ScheduleBadgeVariant;
}

// Pure task-state → badge mapping. Kept out of the card component so its branch
// count stays off the render-function complexity budget and stays testable
// without pulling in the React Native render tree. `tone` carries the live agent
// state so a task whose agent is blocked on a question gets an explicit amber
// badge even when no board field explains the pause.
export function getScheduleBadge(
  task: KanbanTask,
  tone: TaskTone | null,
): ScheduleBadgeDescriptor | null {
  // Board-field reasons that carry precise wording win first.
  if (task.approval?.state === "pending") {
    return { labelKey: "tasks.approval.pending", variant: "warning" };
  }
  if (task.planReadyAt) {
    return { labelKey: "tasks.card.planReady", variant: "success" };
  }
  // A failed analysis is the loudest thing a card can say: it produced no
  // estimate, no billing data, and it will not move on its own. It used to be
  // completely silent — the card simply sat in "Validé" forever wearing a
  // made-up estimate — so it wins over every softer status below.
  if (task.analysis?.state === "failed") {
    return {
      labelKey: task.analysis.exhausted
        ? "tasks.analysis.failedExhausted"
        : "tasks.analysis.failedRetrying",
      variant: "error",
    };
  }
  if (task.refinement === "pending") {
    return { labelKey: "tasks.schedule.estimating" };
  }
  if (task.schedule?.state === "failed") {
    return { labelKey: "tasks.schedule.failed", variant: "error" };
  }
  // "Pause au choix": analyzed but held until the user gives the go.
  if (task.executionHold === true) {
    return { labelKey: "tasks.schedule.heldForReview", variant: "warning" };
  }
  // The live agent is waiting on the user (a question / a permission) with no
  // board field to explain it: surface an explicit amber "waiting for your
  // reply". Wins over a stale "running" schedule badge so the yellow badge and
  // the card's attention shake always agree.
  if (tone === "attention") {
    return { labelKey: "tasks.card.awaitingReply", variant: "warning" };
  }
  const state = task.schedule?.state;
  if (!state) {
    return null;
  }
  if (state === "running" || state === "launching") {
    return { labelKey: "tasks.schedule.running", variant: "success" };
  }
  if (state === "pending_estimate") {
    return { labelKey: "tasks.schedule.estimating" };
  }
  if (task.schedule?.waitingReason === "quiet_hours") {
    return { labelKey: "tasks.schedule.awaitingWindow" };
  }
  return { labelKey: "tasks.schedule.awaiting" };
}
