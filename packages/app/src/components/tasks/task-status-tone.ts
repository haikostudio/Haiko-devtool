import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { KanbanTask } from "@/data/tasks";

// The "voyant" tones a task (or an aggregate of tasks) can signal, mirroring the
// agent toast badge: amber = the task wants the user (a question, a permission, a
// paused go, a ready plan, a failure), a spinning square loader = an agent is
// actively working, blue = queued/planned and waiting for its slot, green =
// finished. `null` = nothing worth a light (an untouched backlog task).
export type TaskTone = "attention" | "running" | "scheduled" | "done";

// Aggregate precedence: surface the most action-needing signal first. A project
// that needs you (amber) outranks one actively working (loader), which outranks
// one merely scheduled (blue), which outranks one simply finished (green).
const AGGREGATE_RANK: Record<TaskTone, number> = {
  attention: 0,
  running: 1,
  scheduled: 2,
  done: 3,
};

// The agent Paseo runs a task through. primaryAgentId is what agent-sync points
// at (interactive/proposing agent); taskAgentId is the pipeline agent. Either one
// carries the live state we want to reflect, so fall back across both.
export function taskAgentId(task: KanbanTask): string | null {
  return task.links.primaryAgentId ?? task.links.taskAgentId ?? null;
}

// Wants the user: proposed-but-unapproved, paused for an explicit go, a
// plan-mode result ready to review, a failed run, or a live agent blocked on a
// permission / question / attention flag.
function wantsUser(task: KanbanTask, agentBucket: WorkspaceStateBucket | undefined): boolean {
  return (
    task.approval?.state === "pending" ||
    task.executionHold === true ||
    Boolean(task.planReadyAt) ||
    task.schedule?.state === "failed" ||
    agentBucket === "needs_input" ||
    agentBucket === "failed" ||
    agentBucket === "attention"
  );
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
function isRunning(task: KanbanTask, agentBucket: WorkspaceStateBucket | undefined): boolean {
  const scheduleState = task.schedule?.state;
  if (scheduleState === "pending_estimate" || scheduleState === "launching") {
    return true;
  }
  return agentBucket === "running";
}

// Queued/planned but not yet working: validated and parked waiting for its slot
// (a quiet-hours window, an available agent quota). Reads as a static blue light.
function isScheduled(task: KanbanTask): boolean {
  return task.schedule?.state === "awaiting_slot";
}

/**
 * Maps one task to its status tone. Reads the board fields (column, completion,
 * approval, hold, plan, schedule) first, then the live agent bucket so a running
 * task that just hit a permission prompt flips from blue to amber in real time.
 *
 * `agentBucket` is the derived live state of the task's linked agent, or
 * undefined when the task has no agent (or its agent is gone).
 */
export function deriveTaskTone(
  task: KanbanTask,
  agentBucket: WorkspaceStateBucket | undefined,
): TaskTone | null {
  // A finished/shipped card whose linked agent has come back to life — the user
  // relaunched a prompt, so the agent is running again or now waiting on a reply
  // — must reflect that renewed activity instead of staying a static green
  // "done" light. Surface the live running / wants-a-reply signal first so the
  // amber "waiting" light (and the card's dim) survive a relaunch; only fall to
  // the terminal "done" tone once the agent is idle or gone.
  if (wantsUser(task, agentBucket)) {
    return "attention";
  }
  if (isRunning(task, agentBucket)) {
    return "running";
  }
  if (isScheduled(task)) {
    return "scheduled";
  }
  // "done" and "deployed" are terminal in the board model — a completed or
  // shipped task with no live agent activity stays a quiet green light. An
  // "in_progress" card that reaches here is no longer actually running: the
  // checks above ruled out live activity, a pending question, and a queued slot,
  // so its agent finished, went idle, was cut, or died without the server moving
  // the card. Read it as a quiet green "done" light rather than leaving a stale
  // spinner (or, worse, no light at all).
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
