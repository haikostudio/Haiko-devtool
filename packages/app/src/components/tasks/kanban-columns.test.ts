import { describe, expect, it } from "vitest";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { buildColumnModels, type ColumnControlsMap } from "./kanban-columns";

const FOLDER = "folder-1";

function makeTask(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    folderId: FOLDER,
    title: overrides.id,
    tags: [],
    column: "done",
    order: 0,
    origin: "manual",
    normalizedTitle: overrides.id,
    links: { agentIds: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBoard(tasks: KanbanTask[]): TaskBoard {
  return { projectId: "p", version: 1, folders: [], tasks };
}

function idsIn(board: TaskBoard, column: TaskColumn, controls?: ColumnControlsMap): string[] {
  const models = buildColumnModels(board, FOLDER, controls);
  return models.find((model) => model.column === column)?.tasks.map((entry) => entry.id) ?? [];
}

describe("buildColumnModels sorting", () => {
  it("defaults to most-recently-updated first in every column", () => {
    const b = makeBoard([
      makeTask({ id: "old", column: "done", updatedAt: "2026-02-01T00:00:00.000Z" }),
      makeTask({ id: "newest", column: "done", updatedAt: "2026-02-03T00:00:00.000Z" }),
      makeTask({ id: "mid", column: "done", updatedAt: "2026-02-02T00:00:00.000Z" }),
    ]);
    // No controls at all → the default ("updated") applies to the column.
    expect(idsIn(b, "done")).toEqual(["newest", "mid", "old"]);
  });

  it("respects the drag-defined order when the column is in manual mode", () => {
    const b = makeBoard([
      // "first" was updated LEAST recently but the user dragged it to the top
      // (order 0), so manual mode must keep it above the fresher card.
      makeTask({ id: "first", column: "backlog", order: 0, updatedAt: "2026-02-01T00:00:00.000Z" }),
      makeTask({
        id: "second",
        column: "backlog",
        order: 1,
        updatedAt: "2026-02-05T00:00:00.000Z",
      }),
    ]);
    const controls: ColumnControlsMap = {
      backlog: {
        query: "",
        sortMode: "manual",
        filter: { priorities: [], deadline: [], tags: [] },
      },
    };
    expect(idsIn(b, "backlog", controls)).toEqual(["first", "second"]);
    // Without the manual override the fresher card would lead.
    expect(idsIn(b, "backlog")).toEqual(["second", "first"]);
  });
});
