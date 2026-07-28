import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import {
  TaskBatchDeployer,
  selectPendingDeployTasks,
  type DeployRunSnapshot,
} from "./batch-deployer.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

describe("selectPendingDeployTasks", () => {
  function task(overrides: Partial<KanbanTask>): KanbanTask {
    return {
      id: "t",
      folderId: "f",
      title: "T",
      tags: [],
      column: "deployed",
      order: 0,
      origin: "user",
      normalizedTitle: "t",
      links: { agentIds: [] },
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
      ...overrides,
    } as KanbanTask;
  }

  test("keeps the queued cards and drops the ones already live", () => {
    const pending = selectPendingDeployTasks([
      task({ id: "queued" }),
      task({ id: "live-stamp", deployedAt: "2026-07-28T11:00:00.000Z" }),
      task({ id: "live-url", deployedUrl: "https://x" }),
      task({ id: "live-window", deployment: { state: "deployed" } }),
      task({ id: "archived", archivedAt: "2026-07-28T11:00:00.000Z" }),
      task({ id: "still-running", column: "in_progress" }),
      task({ id: "just-done", column: "done" }),
      // "Retirer du prochain lot": still on the board, skipped by the batch.
      task({ id: "held", deployHold: true }),
    ]);
    expect(pending.map((entry) => entry.id)).toEqual(["queued"]);
  });
});

describe("TaskBatchDeployer", () => {
  let dir: string;
  let service: TaskBoardService;
  let notes: string[];
  let triggered: { projectId: string; mergeBranches: string[] }[];
  let restarts: string[];
  let perCard: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-batch-deploy-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    notes = [];
    triggered = [];
    restarts = [];
    perCard = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A finished card sitting in the "À déployer" queue, agent + branch linked. */
  async function seedQueued(title: string, branch: string): Promise<KanbanTask> {
    const board = await service.getBoard("proj-1");
    const folder = board.folders[0] ?? (await service.createFolder("proj-1", "Tâches"));
    const task = await service.createTask("proj-1", { folderId: folder.id, title });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      links: { ...current.links, taskAgentId: `agent-${task.id}`, branch },
    }));
    await service.transitionTask("proj-1", task.id, "done");
    await service.transitionTask("proj-1", task.id, "deployed");
    const latest = await service.getBoard("proj-1");
    const queued = latest.tasks.find((entry) => entry.id === task.id);
    if (!queued) throw new Error("task lost");
    return queued;
  }

  function buildDeployer(input: {
    isSelfHost?: boolean;
    url?: string | null;
    runs?: DeployRunSnapshot[];
    started?: boolean;
  }) {
    const runs = [...(input.runs ?? [])];
    return new TaskBatchDeployer({
      taskBoardService: service,
      projectRegistry: { get: async () => ({ projectId: "proj-1", rootPath: "/root/x" }) as never },
      agentManager: {
        appendTimelineItem: async (_agentId: string, item: { type: string; text?: string }) => {
          notes.push(item.text ?? "");
        },
      } as never,
      isSelfHostRoot: () => input.isSelfHost !== false,
      resolveProjectUrl: async () => input.url ?? null,
      triggerDeploy: async (trigger) => {
        triggered.push(trigger);
        return { started: input.started ?? true, error: "déjà en cours" };
      },
      readDeployRun: async () =>
        runs.shift() ?? { deploying: false, phase: null, outcome: null, error: null },
      deployTask: async (_projectId, taskId) => {
        perCard.push(taskId);
      },
      requestDaemonRestart: (reason) => restarts.push(reason),
      sleep: async () => {},
      logger,
    });
  }

  /** Lets the fire-and-forget run finish before assertions read the board. */
  async function settle(check?: () => boolean): Promise<void> {
    for (let index = 0; index < 200; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (check?.()) {
        return;
      }
    }
  }

  test("publishes the whole queue in one run, stamps the cards and restarts the engine", async () => {
    const first = await seedQueued("Login", "task/login");
    const second = await seedQueued("Signup", "task/signup");
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [
        { deploying: true, phase: "build", outcome: null, error: null },
        { deploying: false, phase: "done", outcome: "success", error: null },
      ],
    });

    const result = await deployer.deployAll("proj-1");
    expect(result).toEqual({ started: true, taskIds: [first.id, second.id] });
    await settle(() => restarts.length > 0);

    // ONE publication for the whole batch, carrying both branches.
    expect(triggered).toEqual([
      { projectId: "proj-1", mergeBranches: ["task/login", "task/signup"] },
    ]);
    const board = await service.getBoard("proj-1");
    for (const id of [first.id, second.id]) {
      const card = board.tasks.find((entry) => entry.id === id);
      expect(card?.deployedAt).toBeTruthy();
      expect(card?.deployedUrl).toBe("https://app.haikostudio.cloud");
      expect(card?.deployment?.state).toBe("deployed");
    }
    expect(notes.join("\n")).toContain("Construction de l'application");
    expect(restarts).toEqual(["task_batch_deploy"]);
    // The board carries the run, so the column can show one progress bar and
    // then the "voici ce qui vient d'être mis en ligne" recap.
    expect(board.deployBatch?.state).toBe("success");
    expect(board.deployBatch?.taskIds).toEqual([first.id, second.id]);
    expect(board.deployBatch?.titles).toEqual(["Login", "Signup"]);
    expect(board.deployBatch?.url).toBe("https://app.haikostudio.cloud");
    expect(board.deployBatch?.finishedAt).toBeTruthy();
  });

  test("a held-back card is left out of the run", async () => {
    const shipped = await seedQueued("Login", "task/login");
    const held = await seedQueued("Signup", "task/signup");
    await service.updateTask("proj-1", held.id, { deployHold: true });
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
    });

    const result = await deployer.deployAll("proj-1");
    expect(result.taskIds).toEqual([shipped.id]);
    await settle(() => restarts.length > 0);

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === shipped.id)?.deployedAt).toBeTruthy();
    expect(board.tasks.find((entry) => entry.id === held.id)?.deployedAt ?? null).toBeNull();
  });

  test("a failed publication marks nothing live and says why", async () => {
    const task = await seedQueued("Login", "task/login");
    const deployer = buildDeployer({
      runs: [{ deploying: false, phase: "error", outcome: "failed", error: "build cassé" }],
    });

    await deployer.deployAll("proj-1");
    await settle();

    const board = await service.getBoard("proj-1");
    const card = board.tasks.find((entry) => entry.id === task.id);
    expect(card?.deployedAt ?? null).toBeNull();
    expect(card?.deployment?.state).toBe("failed");
    expect(notes.join("\n")).toContain("build cassé");
    // The engine is only ever restarted after a publication that succeeded.
    expect(restarts).toEqual([]);
    expect(board.deployBatch?.state).toBe("failed");
    expect(board.deployBatch?.error).toContain("build cassé");
  });

  test("a publication that never starts is reported, not swallowed", async () => {
    await seedQueued("Login", "task/login");
    const deployer = buildDeployer({ started: false });

    await deployer.deployAll("proj-1");
    await settle();

    expect(notes.at(-1)).toContain("déjà en cours");
    expect(restarts).toEqual([]);
  });

  test("refuses to publish while a card is still running", async () => {
    await seedQueued("Login", "task/login");
    const running = await service.createTask("proj-1", {
      folderId: (await service.getBoard("proj-1")).folders[0]?.id ?? "",
      title: "Encore en cours",
    });
    await service.moveTask("proj-1", {
      taskId: running.id,
      column: "in_progress",
      index: 0,
      manual: true,
    });

    await expect(buildDeployer({}).deployAll("proj-1")).rejects.toThrow(/en cours/);
    expect(triggered).toHaveLength(0);
  });

  test("refuses when everything in the column is already live", async () => {
    const task = await seedQueued("Login", "task/login");
    await service.markTaskDeployed("proj-1", task.id, { url: "https://app.haikostudio.cloud" });

    await expect(buildDeployer({}).deployAll("proj-1")).rejects.toThrow(/Aucune tâche à déployer/);
  });

  test("an ordinary project deploys card by card, through each card's own agent", async () => {
    const first = await seedQueued("Login", "task/login");
    const second = await seedQueued("Signup", "task/signup");
    const deployer = buildDeployer({ isSelfHost: false });

    await deployer.deployAll("proj-1");
    await settle();

    expect(triggered).toHaveLength(0);
    expect(perCard).toEqual([first.id, second.id]);
    // No single run to follow: each card carries its own publication state.
    expect((await service.getBoard("proj-1")).deployBatch ?? null).toBeNull();
    // No daemon restart on a client project: its own service is restarted by the
    // agent that deployed it.
    expect(restarts).toEqual([]);
  });
});
