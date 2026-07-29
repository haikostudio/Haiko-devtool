import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TaskDeployer } from "./deployer.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import type { AgentStopReason } from "./validator.js";

const logger = pino({ level: "silent" });

describe("TaskDeployer", () => {
  let dir: string;
  let service: TaskBoardService;
  let sent: Array<{ agentId: string; prompt: string }>;
  let idleCallbacks: Array<(reason?: AgentStopReason) => void>;
  let deployer: TaskDeployer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-deployer-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    sent = [];
    idleCallbacks = [];
    deployer = new TaskDeployer({
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

  /** Wait until a confirmed deployment state has landed. */
  async function settled(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const board = await service.getBoard("proj-1");
      if (board.tasks.find((entry) => entry.id === taskId)?.deployment?.state !== "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Deployment window never closed");
  }

  async function doneTask(links?: { taskAgentId?: string }) {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      column: "done" as const,
      links: { ...current.links, taskAgentId: links?.taskAgentId ?? null },
    }));
    return task.id;
  }

  test("hands the deploy prompt to the task's own agent and opens the consent window", async () => {
    const taskId = await doneTask({ taskAgentId: "agent-7" });

    const outcome = await deployer.deploy("proj-1", taskId);

    expect(outcome.dispatched).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe("agent-7");
    expect(sent[0]?.prompt).toContain("DÉPLOIEMENT");
    expect(sent[0]?.prompt).toContain("fonctionnement est ok, tu peux lancer le déploiement");
    expect(sent[0]?.prompt).toContain(`taskId: "${taskId}"`);
    expect(sent[0]?.prompt).toContain("needsDaemonRestart");
    expect(sent[0]?.prompt).toContain("haikostudio.cloud");
    expect(sent[0]?.prompt).toContain("/root/etsigna");

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.deployment?.state).toBe("running");
  });

  test("refuses to deploy a task that has no agent", async () => {
    const taskId = await doneTask();

    await expect(deployer.deploy("proj-1", taskId)).rejects.toThrow(/Aucun agent/);
    expect(sent).toHaveLength(0);
  });

  test("refuses to deploy a card that is not « Terminée »", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      column: "in_progress" as const,
      links: { ...current.links, taskAgentId: "agent-7" },
    }));

    await expect(deployer.deploy("proj-1", task.id)).rejects.toThrow(/pas terminée/);
    expect(sent).toHaveLength(0);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.deployment ?? null).toBeNull();
  });

  test("an agent that pauses without deploying keeps the progress window open", async () => {
    const taskId = await doneTask({ taskAgentId: "agent-7" });
    await deployer.deploy("proj-1", taskId);

    idleCallbacks.forEach((callback) => callback());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === taskId);
    expect(task?.column).toBe("done");
    expect(task?.deployment?.state).toBe("running");
  });

  test("closing window: a card stamped live records a successful deploy", async () => {
    const taskId = await doneTask({ taskAgentId: "agent-7" });
    await deployer.deploy("proj-1", taskId);
    // What the agent's move_task(…, "deployed") does under the hood: the column
    // alone no longer means "live" — a finished card waits in "À déployer".
    await service.markTaskDeployed("proj-1", taskId);

    idleCallbacks.forEach((callback) => callback());
    await settled(taskId);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.deployment?.state).toBe("deployed");
  });

  test("closing window: a live deployedUrl records a successful deploy even without a move", async () => {
    const taskId = await doneTask({ taskAgentId: "agent-7" });
    await deployer.deploy("proj-1", taskId);
    // The work is demonstrably live (auto-publish stamped a URL) but the agent
    // never moved the card to « Déployée ». The window must still close as
    // deployed, not reset to a fresh clickable bar.
    await service.patchTask("proj-1", taskId, (current) => ({
      ...current,
      deployedUrl: "https://etsigna.haikostudio.cloud",
    }));

    idleCallbacks.forEach((callback) => callback());
    await settled(taskId);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === taskId)?.deployment?.state).toBe("deployed");
  });

  test("a terminal agent error records one confirmed deployment failure", async () => {
    const taskId = await doneTask({ taskAgentId: "agent-7" });
    await deployer.deploy("proj-1", taskId);

    idleCallbacks.forEach((callback) => callback("error"));
    await settled(taskId);

    const board = await service.getBoard("proj-1");
    const deployment = board.tasks.find((entry) => entry.id === taskId)?.deployment;
    expect(deployment?.state).toBe("failed");
    expect(deployment?.summary).toContain("erreur confirmée");
  });

  test("a card whose work is already live is a no-op", async () => {
    const taskId = await doneTask({ taskAgentId: "agent-7" });
    await service.transitionTask("proj-1", taskId, "deployed");
    await service.markTaskDeployed("proj-1", taskId);

    const outcome = await deployer.deploy("proj-1", taskId);

    expect(outcome.dispatched).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
