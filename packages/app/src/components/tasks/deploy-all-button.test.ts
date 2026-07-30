import { describe, expect, it } from "vitest";
import type { KanbanTask } from "@/data/tasks";
import {
  countTasksAwaitingDeploy,
  countTasksAwaitingQueue,
  isDeployAllRunning,
} from "./deploy-queue";

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

  it("skips cards held back from the next batch, matching what the run publishes", () => {
    // A held card ("Retirer du prochain lot") stays in the column but the batch
    // skips it, so it must not inflate the button's promise.
    expect(
      countTasksAwaitingDeploy([makeTask({ id: "a" }), makeTask({ id: "b", deployHold: true })]),
    ).toBe(1);
  });

  it("counts finished cards too, because the run sweeps them in", () => {
    // A publication builds the whole checkout, so a card resting in "Terminé"
    // ships whether or not it was queued. The run takes it in and stamps it, and
    // the button must promise exactly that — not one card fewer.
    expect(
      countTasksAwaitingDeploy([
        makeTask({ id: "a", column: "done" }),
        makeTask({ id: "b", column: "deployed" }),
      ]),
    ).toBe(2);
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

describe("countTasksAwaitingQueue", () => {
  it("counts the finished cards nobody has queued yet", () => {
    // "Terminé" holds finished work until the user queues it, so the header count
    // is the only thing that says the column is not idle.
    expect(
      countTasksAwaitingQueue([
        makeTask({ id: "a", column: "done" }),
        makeTask({ id: "b", column: "done" }),
        makeTask({ id: "c", column: "deployed" }),
        makeTask({ id: "d", column: "in_progress" }),
      ]),
    ).toBe(2);
  });

  it("ignores archived cards — filing one away IS the decision not to publish", () => {
    expect(
      countTasksAwaitingQueue([
        makeTask({ id: "a", column: "done", archivedAt: "2026-07-28T12:00:00.000Z" }),
      ]),
    ).toBe(0);
  });
});
