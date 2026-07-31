import { describe, expect, it } from "vitest";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import {
  buildColumnModels,
  EMPTY_COLUMN_CONTROLS,
  KANBAN_COLUMNS,
  type ColumnSortMode,
} from "./kanban-columns";
import { deadlineTagFor, PRIORITY_TAG_BY_LEVEL } from "./task-tags";

// A minimal note-shaped task: only the fields the ordering reads. Priority and
// deadline ride in the flat `tags` array, exactly as the note composer writes them.
function makeNote(
  id: string,
  opts: {
    importance?: "high" | "medium" | "low";
    deadline?: string;
    updatedAt?: string;
    title?: string;
  } = {},
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
    title: opts.title ?? id,
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

function notesColumn(tasks: KanbanTask[]): KanbanTask[] {
  const board: TaskBoard = { version: 1, projectId: "p1", folders: [], tasks };
  const model = buildColumnModels(board).find((entry) => entry.column === "notes");
  return model?.tasks ?? [];
}

// Same column, but with an explicit sort picked from the column's sort menu.
function notesColumnSortedBy(tasks: KanbanTask[], sort: ColumnSortMode): KanbanTask[] {
  const board: TaskBoard = { version: 1, projectId: "p1", folders: [], tasks };
  const model = buildColumnModels(board, {
    notes: { ...EMPTY_COLUMN_CONTROLS, sort },
  }).find((entry) => entry.column === "notes");
  return model?.tasks ?? [];
}

// A minimal backlog-shaped task, optionally awaiting the user's validation.
function makeBacklog(id: string, opts: { pending?: boolean } = {}): KanbanTask {
  return {
    id,
    folderId: "f1",
    title: id,
    tags: [],
    column: "backlog",
    order: 0,
    origin: "manual",
    normalizedTitle: id,
    links: { agentIds: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(opts.pending ? { approval: { state: "pending" as const } } : {}),
  };
}

function backlogColumn(tasks: KanbanTask[]): KanbanTask[] {
  const board: TaskBoard = { version: 1, projectId: "p1", folders: [], tasks };
  const model = buildColumnModels(board).find((entry) => entry.column === "backlog");
  return model?.tasks ?? [];
}

describe("Backlog column", () => {
  it("shows a pending 'à valider' card alongside normal cards", () => {
    const rendered = backlogColumn([
      makeBacklog("normal"),
      makeBacklog("pending", { pending: true }),
    ]);
    expect(rendered.map((task) => task.id)).toContain("pending");
    expect(rendered.map((task) => task.id)).toContain("normal");
  });

  it("keeps a pending proposal hidden outside the backlog column", () => {
    const proposal: KanbanTask = { ...makeBacklog("stray", { pending: true }), column: "notes" };
    const board: TaskBoard = { version: 1, projectId: "p1", folders: [], tasks: [proposal] };
    const notes = buildColumnModels(board).find((entry) => entry.column === "notes");
    expect(notes?.tasks.map((task) => task.id)).not.toContain("stray");
  });
});

describe("Notes column", () => {
  it("is the first column, before backlog", () => {
    expect(KANBAN_COLUMNS[0]).toBe("notes");
    const notesIndex = KANBAN_COLUMNS.indexOf("notes");
    const backlogIndex = KANBAN_COLUMNS.indexOf("backlog" as TaskColumn);
    expect(notesIndex).toBeLessThan(backlogIndex);
  });

  it("orders notes by importance first (high → low → none)", () => {
    const ordered = notesColumn([
      makeNote("none"),
      makeNote("low", { importance: "low" }),
      makeNote("high", { importance: "high" }),
      makeNote("medium", { importance: "medium" }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual(["high", "medium", "low", "none"]);
  });

  it("breaks importance ties by soonest deadline, undated last", () => {
    const ordered = notesColumn([
      makeNote("later", { importance: "high", deadline: "20.01.26" }),
      makeNote("undated", { importance: "high" }),
      makeNote("sooner", { importance: "high", deadline: "05.01.26" }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual(["sooner", "later", "undated"]);
  });
});

describe("Column sort", () => {
  it("defaults to last modified, most recent first", () => {
    const ordered = notesColumn([
      makeNote("old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeNote("newest", { updatedAt: "2026-03-01T00:00:00.000Z" }),
      makeNote("middle", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual(["newest", "middle", "old"]);
  });

  it("sorts alphabetically when the title sort is picked", () => {
    const ordered = notesColumnSortedBy(
      [
        makeNote("c", { title: "Charlie" }),
        makeNote("a", { title: "alpha" }),
        makeNote("b", { title: "Bravo" }),
      ],
      "title",
    );
    expect(ordered.map((task) => task.id)).toEqual(["a", "b", "c"]);
  });

  it("puts the soonest deadline first and undated cards last", () => {
    const ordered = notesColumnSortedBy(
      [
        makeNote("undated"),
        makeNote("later", { deadline: "20.01.26" }),
        makeNote("sooner", { deadline: "05.01.26" }),
      ],
      "deadline",
    );
    expect(ordered.map((task) => task.id)).toEqual(["sooner", "later", "undated"]);
  });
});
