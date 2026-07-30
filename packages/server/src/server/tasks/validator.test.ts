import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import { type AgentStopReason, TaskValidator } from "./validator.js";

const logger = pino({ level: "silent" });

describe("TaskValidator", () => {
  let dir: string;
  let service: TaskBoardService;
  let sent: Array<{ agentId: string; prompt: string }>;
  let idleCallbacks: Array<(reason?: AgentStopReason) => void>;
  let validator: TaskValidator;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-validator-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    sent = [];
    idleCallbacks = [];
    validator = new TaskValidator({
      taskBoardService: service,
      projectRegistry: {
        get: async () => ({ projectId: "proj-1", rootPath: "/root/etsigna" }) as never,
      },
      sendPrompt: async (input) => {
        sent.push(input);
      },
      watchAgentIdle: (_agentId, onIdle) => {
        idleCallbacks.push(onIdle);
        return () => {};
      },
      logger,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Wait until a confirmed validation state has landed. */
  async function settled(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const board = await service.getBoard("proj-1");
      if (board.tasks.find((entry) => entry.id === taskId)?.validation?.state !== "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Validation window never closed");
  }

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

  test("hands the check to the task's own agent and opens the consent window", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });

    const outcome = await validator.validate("proj-1", taskId);

    expect(outcome.dispatched).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe("agent-7");
    expect(sent[0]?.prompt).toContain("CONTRÔLE FINAL");
    expect(sent[0]?.prompt).toContain("travaille silencieusement");
    expect(sent[0]?.prompt).toContain("AUCUN compte-rendu intermédiaire");
    expect(sent[0]?.prompt).toContain("## 2. Ce qui a été fait");
    expect(sent[0]?.prompt).toContain("## 3. Ce que cela implique");
    expect(sent[0]?.prompt).toContain(`taskId: "${taskId}"`);
    // The check is also the deploy onto the project's dev instance — so the
    // prompt must name that instance on the VPS. What it must NOT promise any
    // more is publication: finishing stops the card in "Terminé", and the queue
    // is the user's own press (see docs/task-board-cycle.md).
    expect(sent[0]?.prompt).toContain("haikostudio.cloud");
    expect(sent[0]?.prompt).toContain("autoproject-");
    expect(sent[0]?.prompt).toContain("/root/etsigna");
    expect(sent[0]?.prompt).toContain("elle ne se publie pas toute seule");

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.validation?.state).toBe("running");
  });

  test("refuses to check a task that has no agent to check it", async () => {
    const taskId = await inProgressTask();

    await expect(validator.validate("proj-1", taskId)).rejects.toThrow(/Aucun agent/);
    expect(sent).toHaveLength(0);
  });

  test("refuses to check a card that never reached « En cours »", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      column: "validated" as const,
      links: { ...current.links, taskAgentId: "agent-7" },
    }));

    await expect(validator.validate("proj-1", task.id)).rejects.toThrow(/pas encore en cours/);
    expect(sent).toHaveLength(0);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.validation ?? null).toBeNull();
  });

  test("an agent that pauses without completing keeps the progress window open", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });
    await validator.validate("proj-1", taskId);

    idleCallbacks.forEach((callback) => callback());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === taskId);
    expect(task?.column).toBe("in_progress");
    expect(task?.validation?.state).toBe("running");
  });

  test("closing window: a completed card records a passed check", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });
    await validator.validate("proj-1", taskId);
    await service.transitionTask("proj-1", taskId, "done");

    idleCallbacks.forEach((callback) => callback());
    await settled(taskId);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.validation?.state).toBe("passed");
  });

  test("a terminal agent error records one confirmed validation failure", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });
    await validator.validate("proj-1", taskId);

    idleCallbacks.forEach((callback) => callback("error"));
    await settled(taskId);

    const board = await service.getBoard("proj-1");
    const validation = board.tasks.find((entry) => entry.id === taskId)?.validation;
    expect(validation?.state).toBe("failed");
    expect(validation?.summary).toContain("erreur confirmée");
  });

  test("an already finished card is a no-op", async () => {
    const taskId = await inProgressTask({ taskAgentId: "agent-7" });
    await service.transitionTask("proj-1", taskId, "done");

    const outcome = await validator.validate("proj-1", taskId);

    expect(outcome.passed).toBe(true);
    expect(outcome.dispatched).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
