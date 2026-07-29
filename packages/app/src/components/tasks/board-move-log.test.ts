import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRefusedMoves,
  getRefusedMoves,
  logRefusedMove,
  subscribeToRefusedMoves,
} from "./board-move-log";

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Task",
    tags: [],
    column: "in_progress",
    order: 0,
    origin: "manual",
    normalizedTitle: "task",
    links: { agentIds: [] },
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("refused move history", () => {
  beforeEach(() => {
    clearRefusedMoves();
  });

  it("records refusals newest first, with where the card was going", () => {
    logRefusedMove(makeTask({ id: "a", title: "Login" }), "deployed", "drag");
    logRefusedMove(makeTask({ id: "b", title: "Signup", column: "backlog" }), "archived", "board");

    const [latest, previous] = getRefusedMoves();
    expect(latest).toMatchObject({ taskId: "b", from: "backlog", to: "archived" });
    expect(previous).toMatchObject({ taskId: "a", from: "in_progress", to: "deployed" });
  });

  it("hands back the same array until something is recorded", () => {
    // useSyncExternalStore loops forever on a snapshot rebuilt at every read.
    logRefusedMove(makeTask(), "deployed", "drag");
    expect(getRefusedMoves()).toBe(getRefusedMoves());
  });

  it("notifies subscribers, and stops once they unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeToRefusedMoves(() => {
      calls += 1;
    });
    logRefusedMove(makeTask(), "deployed", "drag");
    expect(calls).toBe(1);
    unsubscribe();
    logRefusedMove(makeTask(), "deployed", "drag");
    expect(calls).toBe(1);
  });

  it("keeps the history bounded so a long session cannot grow one", () => {
    for (let index = 0; index < 40; index += 1) {
      logRefusedMove(makeTask({ id: `t${index}` }), "deployed", "drag");
    }
    expect(getRefusedMoves()).toHaveLength(20);
    expect(getRefusedMoves()[0]?.taskId).toBe("t39");
  });
});
