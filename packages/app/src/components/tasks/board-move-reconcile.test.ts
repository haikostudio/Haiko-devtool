import { describe, expect, it } from "vitest";
import type { KanbanTask, TaskBoard } from "@getpaseo/protocol/tasks/types";
import { type PendingMove, reconcileBoardWithPendingMoves } from "./board-move-reconcile";

const NOW_MS = Date.parse("2024-01-01T00:10:00.000Z");
/** The card's updatedAt as of the last authoritative board we had. */
const KNOWN_UPDATED_AT = "2024-01-01T00:00:00.000Z";

function pendingMove(overrides: Partial<PendingMove> = {}): PendingMove {
  return {
    column: "deployed",
    order: 0,
    knownUpdatedAt: KNOWN_UPDATED_AT,
    expiresAtMs: NOW_MS + 10_000,
    ...overrides,
  };
}

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Some task",
    tags: [],
    column: "done",
    order: 0,
    origin: "manual",
    normalizedTitle: "some task",
    links: { agentIds: [] },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  } as KanbanTask;
}

function makeBoard(tasks: KanbanTask[]): TaskBoard {
  return { version: 1, projectId: "p1", folders: [], tasks } as TaskBoard;
}

describe("reconcileBoardWithPendingMoves — a dropped card stays put", () => {
  it("is a no-op when there is no pending move", () => {
    const board = makeBoard([makeTask({ column: "done" })]);
    const result = reconcileBoardWithPendingMoves(board, new Map(), NOW_MS);
    expect(result.board).toBe(board);
    expect(result.satisfied).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps the card in the target column when a STALE server snapshot still shows the old one", () => {
    // The user dragged t1 done -> deployed; the server hasn't caught up yet.
    const staleServerBoard = makeBoard([makeTask({ id: "t1", column: "done" })]);
    const pending = new Map<string, PendingMove>([["t1", pendingMove()]]);

    const result = reconcileBoardWithPendingMoves(staleServerBoard, pending, NOW_MS);

    // No bounce back to "done": the move overrides the stale snapshot.
    expect(result.board.tasks[0].column).toBe("deployed");
    // Still not confirmed, so the indicator must stay lit.
    expect(result.satisfied).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("reports the move satisfied once the server board reflects the drop", () => {
    const freshServerBoard = makeBoard([makeTask({ id: "t1", column: "deployed" })]);
    const pending = new Map<string, PendingMove>([["t1", pendingMove()]]);

    const result = reconcileBoardWithPendingMoves(freshServerBoard, pending, NOW_MS);

    expect(result.board.tasks[0].column).toBe("deployed");
    // Server caught up: the caller drops the move and clears the indicator.
    expect(result.satisfied).toEqual(["t1"]);
    expect(result.dropped).toEqual([]);
  });

  it("does not touch cards without a pending move", () => {
    const board = makeBoard([
      makeTask({ id: "t1", column: "done" }),
      makeTask({ id: "t2", column: "in_progress" }),
    ]);
    const pending = new Map<string, PendingMove>([["t1", pendingMove()]]);

    const result = reconcileBoardWithPendingMoves(board, pending, NOW_MS);

    expect(result.board.tasks[0].column).toBe("deployed");
    expect(result.board.tasks[1].column).toBe("in_progress");
  });

  it("reports a pending move dropped when its card vanished from the board", () => {
    const board = makeBoard([makeTask({ id: "t2", column: "done" })]);
    const pending = new Map<string, PendingMove>([["t1", pendingMove()]]);

    const result = reconcileBoardWithPendingMoves(board, pending, NOW_MS);

    expect(result.satisfied).toEqual([]);
    expect(result.dropped).toEqual(["t1"]);
  });

  // Terminer une carte : le daemon écrit DEUX fois — d'abord un marquage qui la
  // laisse en « En cours », puis le passage en « Terminé ». Croire la première
  // écriture est exactement ce qui renvoyait la carte en arrière quelques
  // secondes avant qu'elle ne revienne. Le serveur en retard n'est pas un refus.
  it("holds through a mid-flight write that leaves the card in its old column", () => {
    const pending = new Map<string, PendingMove>([["t1", pendingMove({ column: "done" })]]);

    // Écriture 1 : la carte est estampillée, toujours « En cours ».
    const midFlight = reconcileBoardWithPendingMoves(
      makeBoard([
        makeTask({ id: "t1", column: "in_progress", updatedAt: "2024-01-01T00:05:00.000Z" }),
      ]),
      pending,
      NOW_MS,
    );
    expect(midFlight.board.tasks[0].column).toBe("done");
    expect(midFlight.satisfied).toEqual([]);

    // Écriture 2 : elle arrive enfin en « Terminé ».
    const landed = reconcileBoardWithPendingMoves(
      makeBoard([makeTask({ id: "t1", column: "done", updatedAt: "2024-01-01T00:05:01.000Z" })]),
      pending,
      NOW_MS,
    );
    expect(landed.board.tasks[0].column).toBe("done");
    expect(landed.satisfied).toEqual(["t1"]);
  });

  // The button transitions (approve, run, finish) hand the card to a server that
  // routinely carries it FURTHER than the column the user aimed at: "Validé" is
  // followed by "Planifié" and then "En cours" on its own. A claim that only ever
  // released on an exact column match would hold the card back at "Validé".
  it("yields to the server once it has touched the card, even in another column", () => {
    const movedOn = makeBoard([
      makeTask({ id: "t1", column: "in_progress", updatedAt: "2024-01-01T00:05:00.000Z" }),
    ]);
    const pending = new Map<string, PendingMove>([["t1", pendingMove({ column: "validated" })]]);

    const result = reconcileBoardWithPendingMoves(movedOn, pending, NOW_MS);

    expect(result.board.tasks[0].column).toBe("in_progress");
    expect(result.satisfied).toEqual(["t1"]);
  });

  // Same timestamp as the last board we had = this snapshot was built before the
  // server ever saw our move. That is exactly the snapshot that used to bounce it.
  it("keeps the claim while the snapshot carries the very timestamp we already knew", () => {
    const stale = makeBoard([
      makeTask({ id: "t1", column: "backlog", updatedAt: KNOWN_UPDATED_AT }),
    ]);
    const pending = new Map<string, PendingMove>([["t1", pendingMove({ column: "validated" })]]);

    const result = reconcileBoardWithPendingMoves(stale, pending, NOW_MS);

    expect(result.board.tasks[0].column).toBe("validated");
    expect(result.satisfied).toEqual([]);
  });

  // A move the server answers by changing nothing at all must not pin the card
  // for the rest of the session.
  it("abandons a claim that has outlived its deadline", () => {
    const board = makeBoard([makeTask({ id: "t1", column: "done" })]);
    const pending = new Map<string, PendingMove>([
      ["t1", pendingMove({ expiresAtMs: NOW_MS - 1 })],
    ]);

    const result = reconcileBoardWithPendingMoves(board, pending, NOW_MS);

    expect(result.board.tasks[0].column).toBe("done");
    expect(result.satisfied).toEqual(["t1"]);
  });

  it("survives the full bounce scenario: stale snapshot then confirmation, never reverting", () => {
    const pending = new Map<string, PendingMove>([["t1", pendingMove()]]);

    // 1. A stale push lands right after the drop — card must NOT return to "done".
    const stale = reconcileBoardWithPendingMoves(
      makeBoard([makeTask({ id: "t1", column: "done" })]),
      pending,
      NOW_MS,
    );
    expect(stale.board.tasks[0].column).toBe("deployed");
    expect(stale.satisfied).toEqual([]);

    // 2. The confirming push finally reflects the move.
    const confirmed = reconcileBoardWithPendingMoves(
      makeBoard([makeTask({ id: "t1", column: "deployed" })]),
      pending,
      NOW_MS,
    );
    expect(confirmed.board.tasks[0].column).toBe("deployed");
    expect(confirmed.satisfied).toEqual(["t1"]);
  });
});
