import { describe, expect, it } from "vitest";
import type { KanbanTask } from "@/data/tasks";
import { countTasksAwaitingDeploy, isDeployAllRunning } from "./deploy-queue";

function makeTask(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    folderId: "list-1",
    title: "Task",
    tags: [],
    column: "deployed",
    order: 0,
    origin: "user",
    normalizedTitle: "task",
    links: { agentIds: [] },
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  } as KanbanTask;
}

describe("countTasksAwaitingDeploy", () => {
  it("counts the queued cards that are not live yet", () => {
    expect(
      countTasksAwaitingDeploy([
        makeTask({ id: "a" }),
        makeTask({ id: "b" }),
        makeTask({ id: "c", deployedAt: "2026-07-28T12:00:00.000Z" }),
        makeTask({ id: "d", deployedUrl: "https://app.example.com" }),
        makeTask({ id: "e", archivedAt: "2026-07-28T12:00:00.000Z" }),
      ]),
    ).toBe(2);
  });

  it("is zero once everything in the column is online", () => {
    expect(
      countTasksAwaitingDeploy([makeTask({ id: "a", deployment: { state: "deployed" } })]),
    ).toBe(0);
  });
});

describe("the queue button's own state", () => {
  it("stays visible with nothing waiting — a control that vanishes reads as missing", () => {
    // The count drives the label ("Rien à publier" at zero), never whether the
    // button exists: it is pinned at the head of the column either way.
    expect(
      countTasksAwaitingDeploy([makeTask({ id: "a", deployedAt: "2026-07-28T12:00:00.000Z" })]),
    ).toBe(0);
  });
});

describe("isDeployAllRunning", () => {
  it("is true while the batch publication holds a card's deploy window open", () => {
    expect(
      isDeployAllRunning([
        makeTask({ id: "a" }),
        makeTask({ id: "b", deployment: { state: "running" } }),
      ]),
    ).toBe(true);
  });

  it("is false when no card is publishing", () => {
    expect(isDeployAllRunning([makeTask({ id: "a" }), makeTask({ id: "b" })])).toBe(false);
  });
});
