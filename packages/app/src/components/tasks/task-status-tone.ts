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

// Actively working (spinning loader): the scheduler is estimating / launching /
// running, the card sits in the in-progress column, or the live agent is running.
function isRunning(task: KanbanTask, agentBucket: WorkspaceStateBucket | undefined): boolean {
  const scheduleState = task.schedule?.state;
  return (
    task.column === "in_progress" ||
    scheduleState === "pending_estimate" ||
    scheduleState === "launching" ||
    scheduleState === "running" ||
    agentBucket === "running"
  );
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
  // "done" and "deployed" are terminal in the board model — never re-light a
  // completed or shipped task.
  if (task.completedAt || task.column === "done" || task.column === "deployed") {
    return "done";
  }
  if (wantsUser(task, agentBucket)) {
    return "attention";
  }
  if (isRunning(task, agentBucket)) {
    return "running";
  }
  if (isScheduled(task)) {
    return "scheduled";
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
