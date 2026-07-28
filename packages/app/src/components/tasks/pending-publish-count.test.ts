import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import { countPendingPublish } from "./pending-publish-count";

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Task",
    tags: [],
    column: "done",
    order: 0,
    origin: "manual",
    normalizedTitle: "task",
    links: { agentIds: [] },
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("countPendingPublish", () => {
  it("counts finished cards that are not live yet, and the restarts among them", () => {
    const counts = countPendingPublish([
      makeTask({ id: "a", needsDaemonRestart: true }),
      makeTask({ id: "b", needsDaemonRestart: false }),
      makeTask({ id: "c" }),
    ]);
    expect(counts).toEqual({ pending: 3, needingRestart: 1 });
  });

  it("ignores cards that are already live", () => {
    const counts = countPendingPublish([
      makeTask({ id: "a", column: "deployed", deployedAt: "2026-07-28T12:00:00.000Z" }),
      makeTask({ id: "b", deployedUrl: "https://app.example.com", needsDaemonRestart: true }),
      makeTask({ id: "c", deployment: { state: "deployed" } }),
    ]);
    expect(counts).toEqual({ pending: 0, needingRestart: 0 });
  });

  it("counts the cards queued in « À déployer » — queued is not published", () => {
    const counts = countPendingPublish([
      makeTask({ id: "a", column: "deployed", needsDaemonRestart: true }),
      makeTask({ id: "b", column: "deployed", needsDaemonRestart: false }),
    ]);
    expect(counts).toEqual({ pending: 2, needingRestart: 1 });
  });

  it("ignores cards that are not finished", () => {
    const counts = countPendingPublish([
      makeTask({ id: "a", column: "in_progress", needsDaemonRestart: true }),
      makeTask({ id: "b", column: "backlog" }),
      makeTask({ id: "c", column: "notes" }),
    ]);
    expect(counts).toEqual({ pending: 0, needingRestart: 0 });
  });

  it("ignores archived cards — the user filed them away", () => {
    const counts = countPendingPublish([
      makeTask({ id: "a", archivedAt: "2026-07-28T12:00:00.000Z", needsDaemonRestart: true }),
    ]);
    expect(counts).toEqual({ pending: 0, needingRestart: 0 });
  });

  it("counts nothing on an empty board", () => {
    expect(countPendingPublish([])).toEqual({ pending: 0, needingRestart: 0 });
  });
});
