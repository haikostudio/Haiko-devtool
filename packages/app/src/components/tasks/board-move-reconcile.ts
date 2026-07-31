import type { KanbanTask, TaskBoard, TaskColumn } from "@getpaseo/protocol/tasks/types";

/**
 * A card the user just dropped into `column`, held as the LOCAL source of truth
 * for that card until the server catches up. It carries the target column and
 * the slot index the user aimed for.
 *
 * Why this exists: the kanban applies drags optimistically, but the server also
 * pushes authoritative board snapshots. An in-flight push can still show the old
 * column, and applying it verbatim yanks the card back to where it started —
 * then a fresher push jumps it forward again. The card bounces. Keeping the
 * user's move on top of every incoming snapshot until the server reflects it
 * (last write wins) is what makes a dropped card stay put.
 */
export interface PendingMove {
  column: TaskColumn;
  order: number;
  /**
   * The `updatedAt` the card carried in the last authoritative board we had when
   * the move started. This is what tells a stale snapshot from a fresh one: the
   * server stamps `updatedAt` on every change, so a snapshot still carrying this
   * exact value was built before it processed us and must not be believed. Any
   * newer value means the server has since acted on this card — whatever it now
   * says is the truth, including a further transition of its own.
   */
  knownUpdatedAt: string;
  /**
   * Wall-clock deadline. Without it, a server that answers a move by changing
   * neither the column nor `updatedAt` (a silently refused move) would leave the
   * card pinned to a column it never reached, for the rest of the session.
   */
  expiresAtMs: number;
}

/** How long a pending move may override the server before it is abandoned. */
export const PENDING_MOVE_MAX_AGE_MS = 10_000;

export interface ReconcileResult {
  /** The server board with each still-pending move overlaid on its card. */
  board: TaskBoard;
  /** Ids whose target column the server board now reflects — drop them. */
  satisfied: string[];
  /** Ids no longer present on the server board (deleted) — drop them too. */
  dropped: string[];
}

/**
 * Overlay the user's pending moves onto an authoritative server board.
 *
 * For each card with a pending move:
 * - the server already shows it in the target column → the move landed, report
 *   it `satisfied` so the caller can forget it and clear its busy indicator;
 * - the server has touched the card since the move started (`updatedAt` moved
 *   on) → it knows something we don't, so its truth wins and the move is
 *   `satisfied` too. This is what lets a card the server carries FURTHER than we
 *   asked — approved, then scheduled, then running — keep advancing instead of
 *   being held back by our own stale claim;
 * - the snapshot predates the move (same `updatedAt`, different column) → keep
 *   the user's move on top, so a stale snapshot can never bounce the card back;
 * - the move has outlived its deadline → give up and believe the server;
 * - the card vanished from the board → report it `dropped`.
 *
 * The empty-map path returns the server board untouched, so the common case
 * (no move in flight) is a no-op.
 */
export function reconcileBoardWithPendingMoves(
  serverBoard: TaskBoard,
  pendingMoves: ReadonlyMap<string, PendingMove>,
  nowMs: number = Date.now(),
): ReconcileResult {
  if (pendingMoves.size === 0) {
    return { board: serverBoard, satisfied: [], dropped: [] };
  }
  const satisfied: string[] = [];
  const seen = new Set<string>();
  const tasks: KanbanTask[] = serverBoard.tasks.map((task) => {
    const move = pendingMoves.get(task.id);
    if (!move) {
      return task;
    }
    seen.add(task.id);
    // ISO-8601 UTC strings from the same stamper compare correctly as text.
    const serverMovedOn = task.updatedAt > move.knownUpdatedAt;
    if (task.column === move.column || serverMovedOn || nowMs >= move.expiresAtMs) {
      satisfied.push(task.id);
      return task;
    }
    return { ...task, column: move.column, order: move.order };
  });
  const dropped: string[] = [];
  for (const id of pendingMoves.keys()) {
    if (!seen.has(id)) {
      dropped.push(id);
    }
  }
  return { board: { ...serverBoard, tasks }, satisfied, dropped };
}
