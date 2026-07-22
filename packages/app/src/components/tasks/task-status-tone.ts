import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { KanbanTask } from "@/data/tasks";

// The three "voyant" tones a task (or an aggregate of tasks) can signal, mirroring
// the agent toast badge: amber = the task wants the user (a question, a permission,
// a paused go, a ready plan, a failure), blue = something is actively happening,
// green = finished. `null` = nothing worth a light (an untouched backlog task).
export type TaskTone = "attention" | "running" | "done";

// Aggregate precedence: surface the most action-needing signal first. A project
// that needs you (amber) outranks one that is merely working (blue), which
// outranks one that is simply finished (green).
const AGGREGATE_RANK: Record<TaskTone, number> = {
  attention: 0,
  running: 1,
  done: 2,
};

// The agent Paseo runs a task through. primaryAgentId is what agent-sync points
// at (interactive/proposing agent); taskAgentId is the pipeline agent. Either one
// carries the live state we want to reflect, so fall back across both.
export function taskAgentId(task: KanbanTask): string | null {
  return task.links.primaryAgentId ?? task.links.taskAgentId ?? null;
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
  // "done" is terminal in the board model — never re-light a completed task.
  if (task.completedAt || task.column === "done") {
    return "done";
  }

  // Wants the user: proposed-but-unapproved, paused for an explicit go, a
  // plan-mode result ready to review, a failed run, or a live agent blocked on a
  // permission / question / attention flag.
  if (
    task.approval?.state === "pending" ||
    task.executionHold === true ||
    Boolean(task.planReadyAt) ||
    task.schedule?.state === "failed" ||
    agentBucket === "needs_input" ||
    agentBucket === "failed" ||
    agentBucket === "attention"
  ) {
    return "attention";
  }

  // Actively working: the scheduler is analyzing / queued / launching / running,
  // the card sits in the in-progress column, or the live agent is running.
  if (
    task.column === "in_progress" ||
    task.schedule?.state === "pending_estimate" ||
    task.schedule?.state === "awaiting_slot" ||
    task.schedule?.state === "launching" ||
    task.schedule?.state === "running" ||
    agentBucket === "running"
  ) {
    return "running";
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
