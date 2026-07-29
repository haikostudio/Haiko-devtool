import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import { isTaskExecuting, isTaskMoveAllowed } from "./task-move-guard";

// Minimal in-progress task fixture; specs override what drives the guard
// (column, validation, deployment).
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
    links: { agentIds: ["a1"], primaryAgentId: "a1" },
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("isTaskExecuting", () => {
  it("is true for a card sitting in « En cours »", () => {
    expect(isTaskExecuting(makeTask())).toBe(true);
  });

  it("is true wherever the card sits while its final check runs", () => {
    // The bug's exact state: the final check is running, so the work is under
    // way regardless of which column the card is drawn in.
    expect(isTaskExecuting(makeTask({ column: "done", validation: { state: "running" } }))).toBe(
      true,
    );
  });

  it("is false for a card at rest in an upstream column", () => {
    expect(isTaskExecuting(makeTask({ column: "validated" }))).toBe(false);
  });
});

describe("isTaskMoveAllowed", () => {
  it("refuses to walk an « En cours » card back to « Planifié »", () => {
    // The reported bug: dragging out of "En cours" dropped the card back where
    // the scheduler would pick it up again.
    expect(isTaskMoveAllowed(makeTask(), "scheduled")).toBe(false);
  });

  it("refuses every upstream column for an « En cours » card", () => {
    const task = makeTask();
    for (const column of ["notes", "backlog", "validated", "scheduled"] as const) {
      expect(isTaskMoveAllowed(task, column)).toBe(false);
    }
  });

  it("freezes the card in place while its final check runs", () => {
    // The final-check bar owns the "En cours" → "Terminé" transition and will
    // perform it itself; no gesture may pre-empt it, forward or backward.
    const task = makeTask({ validation: { state: "running" } });
    expect(isTaskMoveAllowed(task, "scheduled")).toBe(false);
    expect(isTaskMoveAllowed(task, "done")).toBe(false);
  });

  it("freezes the card in place while a publication runs", () => {
    const task = makeTask({ column: "deployed", deployment: { state: "running" } });
    expect(isTaskMoveAllowed(task, "done")).toBe(false);
  });

  it("still allows the forward move an « En cours » card really offers", () => {
    // "En cours" → "Terminé" routes to the final-check handler (e62ef15b8); the
    // guard must not swallow the one transition the card does offer.
    expect(isTaskMoveAllowed(makeTask(), "done")).toBe(true);
  });

  it("refuses a jump from « En cours » straight to « À déployer »", () => {
    // Skipping "Terminée" would bypass the final check that owns the completion:
    // an executing card reaches the next column and only the next one.
    expect(isTaskMoveAllowed(makeTask(), "deployed")).toBe(false);
  });

  it("refuses « À déployer » for any card that never reached « Terminée »", () => {
    // The publication queue only ever holds finished work, so no at-rest card
    // upstream of "Terminée" may be dropped into it — the same rule the server
    // enforces, kept here so the gesture is a silent no-op instead of a bounce.
    for (const column of ["notes", "backlog", "validated", "scheduled"] as const) {
      expect(isTaskMoveAllowed(makeTask({ column }), "deployed")).toBe(false);
    }
  });

  it("lets a card that already completed re-enter « À déployer »", () => {
    // A shipped card sent back upstream keeps its completion stamp, so re-queuing
    // it skips nothing.
    const requeued = makeTask({ column: "validated", completedAt: "2026-07-24T11:00:00.000Z" });
    expect(isTaskMoveAllowed(requeued, "deployed")).toBe(true);
  });

  it("always allows a re-order inside the same column", () => {
    // Dropping a card among its neighbours is an arrangement, not a transition.
    expect(isTaskMoveAllowed(makeTask({ validation: { state: "running" } }), "in_progress")).toBe(
      true,
    );
  });

  it("leaves cards at rest with the board's usual freedom", () => {
    // A card nobody is working on stays fully draggable, backward included.
    expect(isTaskMoveAllowed(makeTask({ column: "validated" }), "backlog")).toBe(true);
    expect(isTaskMoveAllowed(makeTask({ column: "done" }), "deployed")).toBe(true);
  });

  it("lets a card at rest be filed into « Archivé » by hand", () => {
    // Manual archive: a finished (or any at-rest) card may be dropped into the
    // terminal column, which is what empties the "À déployer" queue on demand.
    expect(isTaskMoveAllowed(makeTask({ column: "done" }), "archived")).toBe(true);
    expect(isTaskMoveAllowed(makeTask({ column: "deployed" }), "archived")).toBe(true);
    expect(isTaskMoveAllowed(makeTask({ column: "backlog" }), "archived")).toBe(true);
  });

  it("freezes a card already in « Archivé » — history only, never walked back", () => {
    const archived = makeTask({ column: "archived" });
    for (const column of ["notes", "backlog", "validated", "done", "deployed"] as const) {
      expect(isTaskMoveAllowed(archived, column)).toBe(false);
    }
    // A re-order among its archived neighbours is still fine.
    expect(isTaskMoveAllowed(archived, "archived")).toBe(true);
  });

  it("still refuses an « En cours » card that tries to skip straight to « Archivé »", () => {
    // Filing is a rest-only privilege: work in flight must finish through its
    // own buttons, never leap over "Terminée" and "À déployer" into the archive.
    expect(isTaskMoveAllowed(makeTask(), "archived")).toBe(false);
  });
});
