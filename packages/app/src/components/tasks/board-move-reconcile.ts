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
}

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
 * - the server still shows the old column → keep the user's move on top, so a
 *   stale snapshot can never bounce the card backward;
 * - the card vanished from the board → report it `dropped`.
 *
 * The empty-map path returns the server board untouched, so the common case
 * (no move in flight) is a no-op.
 */
export function reconcileBoardWithPendingMoves(
  serverBoard: TaskBoard,
  pendingMoves: ReadonlyMap<string, PendingMove>,
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
    if (task.column === move.column) {
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
