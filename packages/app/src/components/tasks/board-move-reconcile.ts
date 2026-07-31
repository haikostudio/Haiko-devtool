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
   * the move started. A snapshot still carrying this exact value was built before
   * the server processed us, so it can never be evidence about our move.
   */
  knownUpdatedAt: string;
  /**
   * Wall-clock deadline. Without it, a server that answers a move by changing
   * neither the column nor `updatedAt` (a silently refused move) would leave the
   * card pinned to a column it never reached, for the rest of the session.
   */
  expiresAtMs: number;
}

/**
 * How long a pending move may override the server before it is abandoned.
 *
 * Generous on purpose: an action can take SEVERAL server writes to land, and
 * every one of them broadcasts a board. Finishing a card is the clearest case —
 * the daemon first stamps the card (still in "En cours"), then moves it to
 * "Terminé" — so a claim that gave up between the two would show exactly the
 * bounce it exists to prevent. This is a backstop against a claim nobody ever
 * answers, not a pacing knob.
 */
export const PENDING_MOVE_MAX_AGE_MS = 120_000;

// Pipeline order, used only to answer "is the server still BEHIND where the user
// put this card?". Not the display order of the board.
const COLUMN_RANK: Record<TaskColumn, number> = {
  notes: 0,
  backlog: 1,
  validated: 2,
  scheduled: 3,
  in_progress: 4,
  done: 5,
  deployed: 6,
  archived: 7,
};

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
 * - the server still shows the card BEHIND the target → an action in flight, not
 *   a refusal: keep the user's move on top. Finishing a card writes twice — a
 *   stamp that leaves it in "En cours", then the move to "Terminé" — and
 *   believing that first write is precisely what made the card jump back;
 * - the server shows it at or past the target in another column, and has acted
 *   since the move started → it knows something we don't, so its truth wins.
 *   This is what lets a card the server carries FURTHER than asked — approved,
 *   then scheduled, then running — keep advancing;
 * - the snapshot predates the move (same `updatedAt`) → keep the user's move on
 *   top, so a stale snapshot can never bounce the card back;
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
    if (task.column === move.column || nowMs >= move.expiresAtMs) {
      satisfied.push(task.id);
      return task;
    }
    // The server is still behind where the user put the card. That is never
    // evidence the move was refused — it is what an action mid-flight looks
    // like, and a card can sit here across several broadcasts before it lands.
    if (COLUMN_RANK[task.column] < COLUMN_RANK[move.column]) {
      return { ...task, column: move.column, order: move.order };
    }
    // The server is at or past the target in another column. Believe it only if
    // it has actually acted since the move started (ISO-8601 UTC strings from
    // the same stamper compare correctly as text); an unchanged timestamp means
    // this snapshot predates us and would drag the card backwards for nothing.
    if (task.updatedAt > move.knownUpdatedAt) {
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
