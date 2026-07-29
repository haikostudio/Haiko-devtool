import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { KanbanTask } from "@/data/tasks";

// The "voyant" tones a task (or an aggregate of tasks) can signal, mirroring the
// agent toast badge: amber = the task wants the user (a question, a permission, a
// paused go, a ready plan, a failure), a spinning square loader = an agent is
// actively working, a soft pulsing dot = launched but the agent is still spinning
// up (waiting to execute), blue = queued/planned and waiting for its slot, green =
// finished. `null` = nothing worth a light (an untouched backlog task).
export type TaskTone = "attention" | "running" | "pending" | "scheduled" | "done";

// Aggregate precedence: surface the most action-needing signal first. A project
// that needs you (amber) outranks one actively working (loader), which outranks
// one launched-but-still-starting (pending), which outranks one merely scheduled
// (blue), which outranks one simply finished (green).
const AGGREGATE_RANK: Record<TaskTone, number> = {
  attention: 0,
  running: 1,
  pending: 2,
  scheduled: 3,
  done: 4,
};

// The agent Paseo runs a task through. primaryAgentId is what agent-sync points
// at (interactive/proposing agent); taskAgentId is the pipeline agent. Either one
// carries the live state we want to reflect, so fall back across both.
export function taskAgentId(task: KanbanTask): string | null {
  return task.links.primaryAgentId ?? task.links.taskAgentId ?? null;
}

// Wants the user: proposed-but-unapproved, paused for an explicit go, a
// plan-mode result ready to review, a failed run, a live agent blocked on a
// permission prompt, or an agent whose last message actually asks something.
//
// It deliberately does NOT include the `attention` bucket. That bucket is the
// agent's "I finished my turn, come look" flag (`requiresAttention` with an
// attentionReason of "finished") — a *notification*, not a pending question. A
// permission prompt or an explicit input request lands in `needs_input`, and an
// error lands in `failed`. Treating "finished" as attention is what made every
// completed card claim it was waiting for a reply nobody owed it.
//
// `agentAwaitsUser` covers the case no lifecycle flag can express: a question
// typed in plain prose at the end of a reply, with no permission prompt behind
// it. The daemon detects it deterministically from the transcript (see the
// server's agent-pending-question) and it clears by itself the moment the user
// answers, since the agent then spoke second-to-last. It is ignored while the
// agent is running again — a fresh run outranks a question already superseded.
function wantsUser(
  task: KanbanTask,
  agentBucket: WorkspaceStateBucket | undefined,
  agentAwaitsUser: boolean | undefined,
): boolean {
  return (
    task.approval?.state === "pending" ||
    task.executionHold === true ||
    Boolean(task.planReadyAt) ||
    task.schedule?.state === "failed" ||
    agentBucket === "failed" ||
    isAgentBlockedOnUser(agentBucket, agentAwaitsUser)
  );
}

// The live-agent half of `wantsUser`: the task's agent is blocked on the user
// RIGHT NOW — stopped on a permission prompt (`needs_input`), or its latest
// reply asks a question with no further run in flight (`agentAwaitsUser`). Both
// are read fresh from the live agent, so they cannot be stale board leftovers.
//
// Split out because these two are the only "wants you" signals allowed to win
// over an action the user just launched (final check / deploy): the running
// action IS what is now blocked, so the card must flip to amber instead of
// spinning a loader on a run that can't advance without an answer. The board
// flags in `wantsUser` (a pending approval, a ready plan) can predate the
// action and must not — they stay behind `isActionRunning`.
function isAgentBlockedOnUser(
  agentBucket: WorkspaceStateBucket | undefined,
  agentAwaitsUser: boolean | undefined,
): boolean {
  return agentBucket === "needs_input" || (agentAwaitsUser === true && agentBucket !== "running");
}

// Actively working (spinning loader): reflect the agent's REAL activity, not a
// stale board flag. The loader lights only when the scheduler is still spinning
// the run up — estimating or launching, before a live agent exists — or when the
// task's live agent is genuinely running.
//
// It deliberately does NOT trust `task.column === "in_progress"` on its own, nor
// a leftover `schedule.state === "running"`. Those persist after the run is over:
// an agent that finished, went idle, was cut by an idle-timeout, or whose process
// died leaves the card parked in the in-progress column with a "running" schedule
// flag it can no longer clear. Once the live agent is idle or gone
// (`agentBucket !== "running"`), the run is over and the loader must stop instead
// of spinning in the void. In the happy path a truly-running agent reports
// `agentBucket === "running"`, so nothing is lost.
//
// The spin-up flags (`refinement === "pending"`, `schedule.state` of
// `pending_estimate` / `launching`) only light the loader BEFORE the card
// actually reaches the in-progress or terminal columns. They animate a card
// being estimated or launched from the backlog. Once the card has moved into
// "En cours" (or done/deployed), those flags are stale leftovers the server can
// no longer clear — an estimate/launch that already happened — so they must not
// resurrect a loader on a card whose agent is idle or gone. Past that point only
// a live `agentBucket === "running"` keeps the loader spinning.
function isRunning(task: KanbanTask, agentBucket: WorkspaceStateBucket | undefined): boolean {
  const scheduleState = task.schedule?.state;
  const inProgressOrTerminal =
    task.column === "in_progress" || task.column === "done" || task.column === "deployed";
  if (
    !inProgressOrTerminal &&
    (task.refinement === "pending" ||
      scheduleState === "pending_estimate" ||
      scheduleState === "launching")
  ) {
    return true;
  }
  return agentBucket === "running";
}

// Launched into "En cours" but not yet actually working. When the scheduler moves
// a card into the in-progress column it sets `schedule.state` to "running" and is
// about to stream the prompt, but the freshly (re)used agent sits in
// `initializing`/`idle` for a beat — which `deriveAgentStateBucket` reports as the
// `done` bucket (initializing and finished-idle are indistinguishable there).
// Without this state the card would fall straight through to the terminal branch
// and flash a premature green "Terminé" the instant it enters "En cours" — the
// exact bug this guards. So while the run is armed (`schedule.state === "running"`)
// and no live agent reports `running` yet, show the honest "En attente
// d'exécution" light.
//
// The tiebreaker is the schedule flag, not the column: on completion the server
// clears `schedule` to null (see scheduler.launch's finish patch), so a genuinely
// finished card — same idle `done` bucket — no longer matches here and correctly
// reads as terminal green. And once the agent reports `agentBucket === "running"`,
// `isRunning` wins ahead of this check and the light becomes the working loader.
function isPendingExecution(
  task: KanbanTask,
  agentBucket: WorkspaceStateBucket | undefined,
): boolean {
  return (
    task.column === "in_progress" && task.schedule?.state === "running" && agentBucket !== "running"
  );
}

// Queued/planned but not yet working: validated and parked waiting for its slot
// (a quiet-hours window, an available agent quota). Reads as a static blue light.
function isScheduled(task: KanbanTask): boolean {
  return task.schedule?.state === "awaiting_slot";
}

// An explicit action the user just launched from the card — the final check
// ("Valider la tâche") or the deploy ("Lancer le déploiement"). The server sets
// `validation.state` / `deployment.state` to "running" the instant the action
// starts, so it is the freshest, most reliable truth about what the agent is
// doing. It must win over a stale "waiting for you" bucket that hasn't caught up
// yet, so the card's light spins instead of staying frozen on amber.
function isActionRunning(task: KanbanTask): boolean {
  return task.validation?.state === "running" || task.deployment?.state === "running";
}

/**
 * Maps one task to its status tone. Reads the board fields (column, completion,
 * approval, hold, plan, schedule) first, then the live agent bucket so a running
 * task that just hit a permission prompt flips from blue to amber in real time.
 *
 * `agentBucket` is the derived live state of the task's linked agent, or
 * undefined when the task has no agent (or its agent is gone).
 * `agentAwaitsUser` is that agent's "my last message asks you something" flag,
 * absent on older daemons (read as "no question detected").
 */
export function deriveTaskTone(
  task: KanbanTask,
  agentBucket: WorkspaceStateBucket | undefined,
  agentAwaitsUser?: boolean,
): TaskTone | null {
  // The task's agent is blocked on the user right now — a permission prompt or a
  // question in its latest reply. This wins over everything, even an action the
  // user just launched (final check / deploy): that action is precisely what is
  // now waiting on an answer, so the card must go amber and shake rather than
  // keep spinning a "Contrôle final en cours" loader on a run that can't move.
  if (isAgentBlockedOnUser(agentBucket, agentAwaitsUser)) {
    return "attention";
  }
  // An action the user just launched from the card (final check / deploy) is
  // running: show the working loader immediately, ahead of any stale amber
  // "waiting for you" signal left over from before the action started.
  if (isActionRunning(task)) {
    return "running";
  }
  // A finished/shipped card whose linked agent has come back to life — the user
  // relaunched a prompt, so the agent is running again or now waiting on a reply
  // — must reflect that renewed activity instead of staying a static green
  // "done" light. Surface the live running / wants-a-reply signal first so the
  // amber "waiting" light (and the card's dim) survive a relaunch; only fall to
  // the terminal "done" tone once the agent is idle or gone.
  if (wantsUser(task, agentBucket, agentAwaitsUser)) {
    return "attention";
  }
  if (isRunning(task, agentBucket)) {
    return "running";
  }
  // Launched, agent still spinning up: a warming-up "En attente d'exécution"
  // light, never a premature green "Terminé". Sits between the live loader and
  // the queued/finished states so the sequence reads pending → running → done.
  if (isPendingExecution(task, agentBucket)) {
    return "pending";
  }
  if (isScheduled(task)) {
    return "scheduled";
  }
  // "done" and "deployed" are terminal in the board model — a completed or
  // shipped task with no live agent activity stays a quiet green light. An
  // "in_progress" card that reaches here has genuinely finished its run: the
  // checks above ruled out live activity, a pending question, an armed run still
  // spinning up (`isPendingExecution`), and a queued slot — and the server clears
  // `schedule` to null on completion, so an armed run can never fall through to
  // here. What's left is an agent that finished (awaiting the user's final
  // check), went idle, was cut, or died. Read it as a quiet green "done" light
  // rather than leaving a stale spinner (or, worse, no light at all).
  if (
    task.completedAt ||
    task.column === "done" ||
    task.column === "deployed" ||
    task.column === "in_progress"
  ) {
    return "done";
  }
  return null;
}

// Whether a card lights its corner pip. The finished-card green pip is an
// "unseen" flag: it shows until the user opens the card (which stamps
// viewedAt), then goes quiet — but the card itself always stays at full
// opacity. A running loader, an amber "waiting for you" light, or a blue
// scheduled dot always show: they signal live or pending state, not
// unread-ness, so a finished card whose agent comes back to life re-lights its
// live badge regardless of viewedAt. Returns false only for a card with no
// tone at all, or a finished card the user has already opened.
export function shouldShowVoyant(task: KanbanTask, tone: TaskTone | null): boolean {
  if (tone === null) {
    return false;
  }
  if (tone === "done") {
    return !task.viewedAt;
  }
  return true;
}

// Rolls a set of task tones up to a single aggregate tone for a folder/project
// card. Returns the highest-precedence tone present, or null when nothing lights.
export function aggregateTaskTones(tones: Iterable<TaskTone | null>): TaskTone | null {
  let best: TaskTone | null = null;
  for (const tone of tones) {
    if (tone === null) {
      continue;
    }
    if (best === null || AGGREGATE_RANK[tone] < AGGREGATE_RANK[best]) {
      best = tone;
    }
  }
  return best;
}
