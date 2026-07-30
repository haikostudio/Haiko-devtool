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
  return (
    task.deployedAt != null || task.deployment?.state === "deployed" || Boolean(task.deployedUrl)
  );
}

/**
 * What the NEXT publication will do with this card, announced before the user
 * publishes:
 *
 * - quiet green "Partira à la prochaine publication" — a finished card rides the
 *   next run whether or not anyone queued it, because a publication builds the
 *   whole checkout;
 * - amber "Retirée du prochain lot" — the user held it back (`deployHold`), which
 *   is the louder of the two and therefore wins.
 *
 * Either way the notice rides the card for the whole wait and goes away the moment
 * the work is live: the card then says "Déployé". Announcing the departure is what
 * turns a surprise into a decision — that a finished card ships invisibly was the
 * actual bug behind "je n'ai pas demandé à publier ça".
 *
 * It used to say "Redémarrage requis" / "Republication simple" instead. Both are
 * gone: a publication now restarts the engine every time, so telling the user
 * which half of the batch needed it only invited them to wonder what the other
 * half was waiting for.
 */
export function getPublishNotice(task: KanbanTask): ScheduleBadgeDescriptor | null {
  if (isTaskDeployed(task)) {
    return null;
  }
  if (task.column !== "done" && task.column !== "deployed") {
    return null;
  }
  return task.deployHold === true
    ? { labelKey: "tasks.card.publishHeld", variant: "warning" }
    : { labelKey: "tasks.card.ridesNextPublish", variant: "success" };
}

/**
 * The card's own "Redémarrer le moteur" gesture is offered on the other side of
 * the publication: once the work IS live and it needed a restart, the restart is
 * the last step standing between the user and their feature. Before that the
 * button would restart the daemon for a change that is not published yet.
 */
export function offersDaemonRestart(task: KanbanTask): boolean {
  return task.needsDaemonRestart === true && isTaskDeployed(task);
}

// A failed analysis is the loudest thing a card can say: it produced no estimate,
// no billing data, and it will not move on its own. It used to be completely
// silent — the card simply sat in "Validé" forever wearing a made-up estimate —
// so it wins over every softer status below.
//
// Defensive twin of the server-side reconciliation (estimator.recordFailure): a
// stale failure record must NEVER shout over a card that actually carries an
// estimate. If two analyses raced on the card's agent and a real estimate landed,
// the card succeeded — show the result, not "Analyse impossible". Kept as its own
// function so getScheduleBadge stays under the branch-complexity budget.
function analysisFailureBadge(task: KanbanTask): ScheduleBadgeDescriptor | null {
  if (task.analysis?.state !== "failed" || task.estimate) {
    return null;
  }
  return {
    labelKey: task.analysis.exhausted
      ? "tasks.analysis.failedExhausted"
      : "tasks.analysis.failedRetrying",
    variant: "error",
  };
}

function actionWindowBadge(task: KanbanTask): ScheduleBadgeDescriptor | null {
  if (task.deployment?.state === "running") {
    return { labelKey: "tasks.card.deploying", variant: "success" };
  }
  if (task.deployment?.state === "failed") {
    return { labelKey: "tasks.card.deployFailed", variant: "error" };
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
  // A failed analysis (with no estimate to override it) wins over every softer
  // status below. See analysisFailureBadge for the reconciliation rule.
  const failureBadge = analysisFailureBadge(task);
  if (failureBadge) {
    return failureBadge;
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
  // A card in "Planifié" (awaiting_slot) never claims "Analyse en cours": analysis
  // belongs to "Validé", and a card is only promoted here once its agent has
  // actually released its analysis turn (see the estimator's waitForAgentAtRest).
  // So a running agent on a queued card means the launch is starting — let it fall
  // through to the launch/awaiting wording, never back to an analysis badge that
  // would contradict the column.
  if (task.schedule?.waitingReason === "quiet_hours") {
    return { labelKey: "tasks.schedule.awaitingWindow" };
  }
  if (task.schedule?.waitingReason === "quota") {
    return { labelKey: "tasks.schedule.awaitingQuota" };
  }
  // A concrete hold recorded by the scheduler: a sibling owns the shared
  // worktree, or every slot is taken. Read BEFORE "launchingSoon" — a held card
  // that keeps promising an imminent launch is the "elle reste dans Planifié et
  // rien ne se passe" report.
  if (task.schedule?.waitingBlocker === "shared_worktree") {
    return { labelKey: "tasks.schedule.awaitingSibling", variant: "warning" };
  }
  if (task.schedule?.waitingBlocker === "slots_busy") {
    return { labelKey: "tasks.schedule.awaitingSlotFree", variant: "warning" };
  }
  // No blocking reason yet: a light task is about to launch (say so, rather than
  // the vague "en attente de créneau"); a heavy/off-peak task is parked for the
  // window — the card shows the concrete "Vers 01:00" time beside this badge.
  if (task.schedule?.state === "awaiting_slot" && !waitsForOffPeak(task)) {
    return { labelKey: "tasks.schedule.launchingSoon", variant: "success" };
  }
  return { labelKey: "tasks.schedule.awaiting" };
}
