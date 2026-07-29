// Console tracing AND a small in-memory history of the board gestures the move
// guard refuses. A refusal is a silent no-op on purpose (the card simply stays
// put — see task-move-guard), and silence is exactly what makes "j'ai déplacé la
// carte et rien ne s'est passé" impossible to diagnose after the fact. Every
// refused drag, menu pick or chevron press leaves a line here instead. Grep for
// "[paseo:board-move]". Intentionally active in production builds: the gestures
// this traces happen on the user's real board, never in dev.
import type { KanbanTask, TaskColumn } from "@/data/tasks";

export interface RefusedMove {
  taskId: string;
  title: string;
  from: TaskColumn;
  to: TaskColumn;
  /** Which gesture asked: the drag, the board's own move handler, a menu. */
  source: string;
  /** Epoch ms, so the panel can say "il y a 2 min" without a second clock. */
  at: number;
}

/**
 * How many refusals are kept. Deliberately small: this answers "what did I just
 * try that didn't take?", not "what did I do all week". A bounded buffer also
 * means the history can never grow into a leak on a long-lived session.
 */
const HISTORY_LIMIT = 20;

const history: RefusedMove[] = [];
const listeners = new Set<() => void>();

export function logRefusedMove(task: KanbanTask, target: TaskColumn, source: string): void {
  const entry: RefusedMove = {
    taskId: task.id,
    title: task.title,
    from: task.column,
    to: target,
    source,
    at: Date.now(),
  };
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) {
    history.length = HISTORY_LIMIT;
  }
  publish();
  console.info("[paseo:board-move] refused", {
    ...entry,
    // The two states that explain most refusals, so the line answers "why?" on
    // its own instead of sending the reader back to the guard.
    validation: task.validation?.state ?? null,
    deployment: task.deployment?.state ?? null,
    completedAt: task.completedAt ?? null,
  });
}

/**
 * A stable snapshot, swapped only when the history changes — `useSyncExternalStore`
 * re-renders forever if `getSnapshot` hands back a fresh array every call.
 */
let snapshot: readonly RefusedMove[] = [];

function publish(): void {
  snapshot = [...history];
  for (const listener of listeners) {
    listener();
  }
}

/** Newest first. Returns the same array instance until a refusal is recorded. */
export function getRefusedMoves(): readonly RefusedMove[] {
  return snapshot;
}

export function subscribeToRefusedMoves(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget everything recorded so far. */
export function clearRefusedMoves(): void {
  history.length = 0;
  publish();
}
