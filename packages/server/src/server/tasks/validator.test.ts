import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import { TaskValidator } from "./validator.js";

const logger = pino({ level: "silent" });

describe("TaskValidator", () => {
  let dir: string;
  let service: TaskBoardService;
  let validator: TaskValidator;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-validator-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    validator = new TaskValidator({ taskBoardService: service, logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function inProgressTask(links?: { taskAgentId?: string }) {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      column: "in_progress" as const,
      links: { ...current.links, taskAgentId: links?.taskAgentId ?? null },
    }));
    return task.id;
  }

  test("finishing a card is a plain move to « Terminé »", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });

    const outcome = await validator.validate("proj-1", taskId);

    expect(outcome.passed).toBe(true);
    // Nothing is handed to an agent any more: no check, and above all no deploy.
    expect(outcome.dispatched).toBe(false);
    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === taskId);
    expect(task?.column).toBe("done");
    expect(task?.queueOnComplete).toBe(false);
  });

  test("finishing needs no agent at all", async () => {
    const taskId = await inProgressTask();

    await validator.validate("proj-1", taskId);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.column).toBe("done");
  });

  test("no check window is ever opened, so no agent can complete a card", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });

    await validator.validate("proj-1", taskId);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.validation ?? null).toBeNull();
  });

  test("a stale check window left by an older daemon is cleared on the way out", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });
    await service.patchTask("proj-1", taskId, (current) => ({
      ...current,
      validation: { state: "running" as const, checkedAt: new Date().toISOString() },
    }));

    await validator.validate("proj-1", taskId);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.validation ?? null).toBeNull();
  });

  test("« Terminer et mettre en file » arms the queue hop", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });

    await validator.validate("proj-1", taskId, true);

    // The flag is read (and cleared) by the completion listener, which is not
    // wired in this test — so what it proves here is that the arming happened
    // before the card moved.
    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === taskId);
    expect(task?.column).toBe("done");
    expect(task?.queueOnComplete).toBe(true);
  });

  test("refuses to finish a card that never reached « En cours »", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      column: "validated" as const,
      links: { ...current.links, taskAgentId: "agent-7" },
    }));

    await expect(validator.validate("proj-1", task.id)).rejects.toThrow(/pas encore en cours/);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.column).toBe("validated");
  });

  test("an already finished card is a no-op", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });
    await service.transitionTask("proj-1", taskId, "done");

    const outcome = await validator.validate("proj-1", taskId);

    expect(outcome.passed).toBe(true);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.task.column).toBe("done");
  });
});
