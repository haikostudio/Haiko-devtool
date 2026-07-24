import { describe, expect, it } from "vitest";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { buildColumnModels, KANBAN_COLUMNS } from "./kanban-columns";
import { deadlineTagFor, PRIORITY_TAG_BY_LEVEL } from "./task-tags";

// A minimal note-shaped task: only the fields the ordering reads. Priority and
// deadline ride in the flat `tags` array, exactly as the note composer writes them.
function makeNote(
  id: string,
  opts: { importance?: "high" | "medium" | "low"; deadline?: string; updatedAt?: string } = {},
): KanbanTask {
  const tags: string[] = [];
  if (opts.importance) {
    tags.push(PRIORITY_TAG_BY_LEVEL[opts.importance]);
  }
  if (opts.deadline) {
    const tag = deadlineTagFor(opts.deadline);
    if (tag) {
      tags.push(tag);
    }
  }
  return {
    id,
    folderId: "f1",
    title: id,
    tags,
    column: "notes",
    order: 0,
    origin: "manual",
    normalizedTitle: id,
    links: { agentIds: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function notesColumn(tasks: KanbanTask[], now: Date): KanbanTask[] {
  const board: TaskBoard = { version: 1, projectId: "p1", folders: [], tasks };
  const model = buildColumnModels(board, "f1", undefined, now).find(
    (entry) => entry.column === "notes",
  );
  return model?.tasks ?? [];
}

describe("Notes column", () => {
  it("is the first column, before backlog", () => {
    expect(KANBAN_COLUMNS[0]).toBe("notes");
    const notesIndex = KANBAN_COLUMNS.indexOf("notes");
    const backlogIndex = KANBAN_COLUMNS.indexOf("backlog" as TaskColumn);
    expect(notesIndex).toBeLessThan(backlogIndex);
  });

  it("orders notes by importance first (high → low → none)", () => {
    const now = new Date(2026, 0, 1);
    const ordered = notesColumn(
      [
        makeNote("none"),
        makeNote("low", { importance: "low" }),
        makeNote("high", { importance: "high" }),
        makeNote("medium", { importance: "medium" }),
      ],
      now,
    );
    expect(ordered.map((task) => task.id)).toEqual(["high", "medium", "low", "none"]);
  });

  it("breaks importance ties by soonest deadline, undated last", () => {
    const now = new Date(2026, 0, 1);
    const ordered = notesColumn(
      [
        makeNote("later", { importance: "high", deadline: "20.01.26" }),
        makeNote("undated", { importance: "high" }),
        makeNote("sooner", { importance: "high", deadline: "05.01.26" }),
      ],
      now,
    );
    expect(ordered.map((task) => task.id)).toEqual(["sooner", "later", "undated"]);
  });
});
