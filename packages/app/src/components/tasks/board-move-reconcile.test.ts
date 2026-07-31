import { describe, expect, it } from "vitest";
import type { KanbanTask, TaskBoard } from "@getpaseo/protocol/tasks/types";
import { type PendingMove, reconcileBoardWithPendingMoves } from "./board-move-reconcile";

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
    const result = reconcileBoardWithPendingMoves(board, new Map());
    expect(result.board).toBe(board);
    expect(result.satisfied).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps the card in the target column when a STALE server snapshot still shows the old one", () => {
    // The user dragged t1 done -> deployed; the server hasn't caught up yet.
    const staleServerBoard = makeBoard([makeTask({ id: "t1", column: "done" })]);
    const pending = new Map<string, PendingMove>([["t1", { column: "deployed", order: 0 }]]);

    const result = reconcileBoardWithPendingMoves(staleServerBoard, pending);

    // No bounce back to "done": the move overrides the stale snapshot.
    expect(result.board.tasks[0].column).toBe("deployed");
    // Still not confirmed, so the indicator must stay lit.
    expect(result.satisfied).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("reports the move satisfied once the server board reflects the drop", () => {
    const freshServerBoard = makeBoard([makeTask({ id: "t1", column: "deployed" })]);
    const pending = new Map<string, PendingMove>([["t1", { column: "deployed", order: 0 }]]);

    const result = reconcileBoardWithPendingMoves(freshServerBoard, pending);

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
    const pending = new Map<string, PendingMove>([["t1", { column: "deployed", order: 0 }]]);

    const result = reconcileBoardWithPendingMoves(board, pending);

    expect(result.board.tasks[0].column).toBe("deployed");
    expect(result.board.tasks[1].column).toBe("in_progress");
  });

  it("reports a pending move dropped when its card vanished from the board", () => {
    const board = makeBoard([makeTask({ id: "t2", column: "done" })]);
    const pending = new Map<string, PendingMove>([["t1", { column: "deployed", order: 0 }]]);

    const result = reconcileBoardWithPendingMoves(board, pending);

    expect(result.satisfied).toEqual([]);
    expect(result.dropped).toEqual(["t1"]);
  });

  it("survives the full bounce scenario: stale snapshot then confirmation, never reverting", () => {
    const pending = new Map<string, PendingMove>([["t1", { column: "deployed", order: 0 }]]);

    // 1. A stale push lands right after the drop — card must NOT return to "done".
    const stale = reconcileBoardWithPendingMoves(
      makeBoard([makeTask({ id: "t1", column: "done" })]),
      pending,
    );
    expect(stale.board.tasks[0].column).toBe("deployed");
    expect(stale.satisfied).toEqual([]);

    // 2. The confirming push finally reflects the move.
    const confirmed = reconcileBoardWithPendingMoves(
      makeBoard([makeTask({ id: "t1", column: "deployed" })]),
      pending,
    );
    expect(confirmed.board.tasks[0].column).toBe("deployed");
    expect(confirmed.satisfied).toEqual(["t1"]);
  });
});
