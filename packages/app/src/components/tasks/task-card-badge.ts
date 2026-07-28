import type { KanbanTask } from "@/data/tasks";
import { waitsForOffPeak } from "@/components/tasks/task-schedule";
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
// The final check ("Valider la tâche") and the deploy ("Lancer le déploiement")
// each open a "running" window the instant they start and close it the moment
// the agent stops, so this reflects the agent's REAL current action — it can
// never stick. It is the freshest truth about what the card is doing, so it wins
// over every other status, including a stale "waiting for your reply" that
// lingers until the agent starts streaming. Kept as its own function so
// getScheduleBadge stays under the branch-complexity budget.
// True once the card's work is actually live. The strongest signal is an
// explicit deploy that reached "deployed"; the everyday one is `deployedUrl`,
// which the server stamps the moment a completed card is published (Paseo's own
// web app, or the project's dev instance). Derived from server truth, never from
// a client flag, so a done card that was already published never lies about it.
export function isTaskDeployed(task: KanbanTask): boolean {
  return task.deployment?.state === "deployed" || Boolean(task.deployedUrl);
}

/**
 * What publishing this card will take, announced BEFORE the user publishes:
 *
 * - amber "Redémarrage requis" — the work only takes effect once the daemon is
 *   restarted (a server-side change);
 * - quiet green "Republication simple" — an app-only change; publishing is the
 *   whole story.
 *
 * Both are advance warnings, so they ride the card for the whole wait and go
 * away the moment the work is live: the card then says "Déployé", and the user
 * has already been told what remains. Saying BOTH cases out loud is deliberate —
 * silence would be indistinguishable from "the daemon hasn't answered yet".
 *
 * The verdict is resolved by the daemon from the files the next publication will
 * carry; a card it could not settle carries no flag and shows nothing.
 */
export function getPublishNotice(task: KanbanTask): ScheduleBadgeDescriptor | null {
  if (task.needsDaemonRestart === undefined || task.column === "deployed" || isTaskDeployed(task)) {
    return null;
  }
  return task.needsDaemonRestart
    ? { labelKey: "tasks.card.needsRestart", variant: "warning" }
    : { labelKey: "tasks.card.republishOnly", variant: "success" };
}

/**
 * The card's own "Redémarrer le moteur" gesture is offered on the other side of
 * the publication: once the work IS live and it needed a restart, the restart is
 * the last step standing between the user and their feature. Before that the
 * button would restart the daemon for a change that is not published yet.
 */
export function offersDaemonRestart(task: KanbanTask): boolean {
  return task.needsDaemonRestart === true && (task.column === "deployed" || isTaskDeployed(task));
}

function actionWindowBadge(task: KanbanTask): ScheduleBadgeDescriptor | null {
  if (task.deployment?.state === "running") {
    return { labelKey: "tasks.card.deploying", variant: "success" };
  }
  if (task.validation?.state === "running") {
    return { labelKey: "tasks.card.finalCheck", variant: "success" };
  }
  if (task.deployment?.state === "failed") {
    return { labelKey: "tasks.card.deployFailed", variant: "error" };
  }
  if (task.validation?.state === "failed") {
    return { labelKey: "tasks.card.finalCheckFailed", variant: "error" };
  }
  return null;
}

export function getScheduleBadge(
  task: KanbanTask,
  tone: TaskTone | null,
): ScheduleBadgeDescriptor | null {
  // An action the user launched right from the card wins over everything below.
  const actionBadge = actionWindowBadge(task);
  if (actionBadge) {
    return actionBadge;
  }
  // A terminal "Déployé" truth: the work is live. Sits just under the running
  // action window (a re-deploy still shows its live spinner first) and above the
  // softer board states, so a published card reads as shipped at a glance instead
  // of falling back to a blank or a stale schedule badge.
  if (isTaskDeployed(task)) {
    return { labelKey: "tasks.card.deployed", variant: "success" };
  }
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
  // The live agent is genuinely blocked on the user (a question, a permission
  // prompt) with no board field to explain it: surface an explicit amber "needs
  // an action from you". Wins over a stale "running" schedule badge so the
  // yellow badge and the card's attention shake always agree. An agent that
  // merely FINISHED never reaches here — that is a "done" tone, handled below.
  if (tone === "attention") {
    return { labelKey: "tasks.card.needsAction", variant: "warning" };
  }
  // Nothing is expected from the user and nothing is running: the card's work is
  // over, so say "Terminé" plainly. Sits above the schedule-state fallbacks on
  // purpose — a finished card often keeps a stale `schedule.state === "running"`
  // the server can no longer clear, and a green "En exécution" on an idle card is
  // exactly the kind of lie this badge is meant to stop telling.
  if (tone === "done") {
    return { labelKey: "tasks.card.finished", variant: "success" };
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
  return queuedBadge(task);
}

// A card sitting in "awaiting_slot": say WHEN/WHY it is queued instead of a flat
// "en attente de créneau". The scheduler records why it last held the task back;
// a task it never held (light "auto"/"asap") carries no reason and launches on
// the next tick.
function queuedBadge(task: KanbanTask): ScheduleBadgeDescriptor {
  if (task.schedule?.waitingReason === "quiet_hours") {
    return { labelKey: "tasks.schedule.awaitingWindow" };
  }
  if (task.schedule?.waitingReason === "quota") {
    return { labelKey: "tasks.schedule.awaitingQuota" };
  }
  // No blocking reason yet: a light task is about to launch (say so, rather than
  // the vague "en attente de créneau"); a heavy/off-peak task is parked for the
  // window — the card shows the concrete "Vers 01:00" time beside this badge.
  if (task.schedule?.state === "awaiting_slot" && !waitsForOffPeak(task)) {
    return { labelKey: "tasks.schedule.launchingSoon", variant: "success" };
  }
  return { labelKey: "tasks.schedule.awaiting" };
}
