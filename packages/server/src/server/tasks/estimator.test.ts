import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import { TaskEstimator } from "./estimator.js";

const logger = pino({ level: "silent" });

function fakeProjectRegistry(records: PersistedProjectRecord[]): ProjectRegistry {
  return {
    list: async () => records,
    get: async (projectId: string) =>
      records.find((record) => record.projectId === projectId) ?? null,
  } as ProjectRegistry;
}

function projectRecord(projectId: string): PersistedProjectRecord {
  return {
    projectId,
    rootPath: `/tmp/${projectId}`,
    kind: "git",
    displayName: projectId,
    customName: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("TaskEstimator", () => {
  let dir: string;
  let service: TaskBoardService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-estim-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Tasks are born in backlog; a scheduled task is one the user has moved into
  // the pipeline. Transition it so the schedule arms (pending_estimate).
  async function moveToScheduled(taskId: string) {
    const board = await service.transitionTask("proj-1", taskId, "scheduled");
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task not found after transition: ${taskId}`);
    }
    return task;
  }

  async function seedScheduledTask() {
    const folder = await service.createFolder("proj-1", "Auth");
    const created = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Implement login flow",
    });
    const task = await moveToScheduled(created.id);
    expect(task.schedule?.state).toBe("pending_estimate");
    return task;
  }

  function buildEstimator(options: { finalText: string | Error }) {
    const runAgent = vi.fn(async () => {
      if (options.finalText instanceof Error) {
        throw options.finalText;
      }
      return { canceled: false, finalText: options.finalText, timeline: [] };
    });
    const createAgent = vi.fn(async () => ({
      snapshot: { id: "estimator-agent-1" },
      initialPromptError: null,
    }));
    const estimator = new TaskEstimator({
      agentManager: { runAgent, archiveAgent: vi.fn(async () => {}) } as never,
      createAgent: createAgent as never,
      taskBoardService: service,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      logger,
    });
    return { estimator, runAgent, createAgent };
  }

  const okEstimate = JSON.stringify({
    tokens: 10_000,
    quotaPercent: 2,
    estimatedMinutes: 10,
    confidence: "high",
    summary: "ok",
  });

  /**
   * Estimator whose analysis turn is gated on a shared latch so a test can
   * observe how many analyses run at once. `runAgent` bumps a live counter,
   * records the peak, then waits a tick before returning — long enough for a
   * sibling analysis to overlap if the scheduler allows it.
   */
  function buildConcurrencyProbe(maxConcurrent?: number) {
    let active = 0;
    let peak = 0;
    let agentSeq = 0;
    const runAgent = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { canceled: false, finalText: okEstimate, timeline: [] };
    });
    const createAgent = vi.fn(async () => {
      agentSeq += 1;
      return { snapshot: { id: `estimator-agent-${agentSeq}` }, initialPromptError: null };
    });
    const estimator = new TaskEstimator({
      agentManager: { runAgent, archiveAgent: vi.fn(async () => {}) } as never,
      createAgent: createAgent as never,
      taskBoardService: service,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      logger,
      ...(maxConcurrent != null ? { maxConcurrent } : {}),
    });
    return { estimator, runAgent, peak: () => peak };
  }

  async function scheduledTaskInFolder(folderName: string, title: string) {
    const folder = await service.createFolder("proj-1", folderName);
    const created = await service.createTask("proj-1", { folderId: folder.id, title });
    return moveToScheduled(created.id);
  }

  test("applies a structured estimate with estimatedMinutes and advances the schedule", async () => {
    const task = await seedScheduledTask();
    const { estimator } = buildEstimator({
      finalText: JSON.stringify({
        tokens: 120_000,
        quotaPercent: 12,
        estimatedMinutes: 25,
        confidence: "high",
        summary: "Petit périmètre bien délimité.",
      }),
    });

    estimator.requestEstimate("proj-1", task.id);

    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks[0]?.estimate).toBeTruthy();
    });
    const board = await service.getBoard("proj-1");
    const estimated = board.tasks[0];
    expect(estimated?.estimate?.estimatedMinutes).toBe(25);
    expect(estimated?.estimate?.quotaPercent).toBe(12);
    expect(estimated?.schedule?.state).toBe("awaiting_slot");
  });

  test("spawns a visible agent linked to the task and parses a fenced estimate", async () => {
    const task = await seedScheduledTask();
    const { estimator, createAgent, runAgent } = buildEstimator({
      finalText: [
        "Voici mon analyse : périmètre limité, deux fichiers concernés, faible risque.",
        "```json",
        JSON.stringify({
          tokens: 90_000,
          quotaPercent: 8,
          estimatedMinutes: 20,
          confidence: "medium",
          summary: "Périmètre restreint.",
        }),
        "```",
      ].join("\n"),
    });

    estimator.requestEstimate("proj-1", task.id);

    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks[0]?.estimate).toBeTruthy();
    });

    const board = await service.getBoard("proj-1");
    const analyzed = board.tasks[0];
    expect(analyzed?.estimate?.quotaPercent).toBe(8);
    expect(analyzed?.estimate?.estimatedMinutes).toBe(20);
    // The analysis agent is visible and linked to the task, so the task chat
    // mirrors it live and the scheduler reuses it for execution.
    expect(analyzed?.links.taskAgentId).toBe("estimator-agent-1");
    expect(analyzed?.links.primaryAgentId).toBe("estimator-agent-1");
    expect(runAgent).toHaveBeenCalledTimes(1);
    const createCall = createAgent.mock.calls[0]?.[0];
    // Not an internal throwaway agent. And it runs IN PLACE on the project's main
    // branch: no branch and no worktree is cut per task any more, so every task
    // shares one context and the deploy step has nothing to reconcile.
    expect(createCall).not.toHaveProperty("internal");
    expect(createCall).toHaveProperty("title", "Tâche : Implement login flow");
    expect(createCall).not.toHaveProperty("worktree");
  });

  test("falls back to a conservative estimate (with minutes) when the agent fails", async () => {
    const task = await seedScheduledTask();
    const { estimator } = buildEstimator({ finalText: new Error("agent exploded") });

    estimator.requestEstimate("proj-1", task.id);

    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks[0]?.estimate).toBeTruthy();
    });
    const board = await service.getBoard("proj-1");
    const estimated = board.tasks[0];
    expect(estimated?.estimate?.confidence).toBe("low");
    // The fallback is the agent's own (short, realistic) runtime, not a flat
    // human-scale hour: unknown work reads as "light" and is governed by the
    // quota gate rather than blindly parked until quiet hours.
    expect(estimated?.estimate?.estimatedMinutes).toBe(15);
    expect(estimated?.schedule?.state).toBe("awaiting_slot");
  });

  test("analyzes tasks from different folders in parallel", async () => {
    const taskA = await scheduledTaskInFolder("Auth", "Login flow");
    const taskB = await scheduledTaskInFolder("Billing", "Invoices");
    const { estimator, peak } = buildConcurrencyProbe();

    estimator.requestEstimate("proj-1", taskA.id);
    estimator.requestEstimate("proj-1", taskB.id);

    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks.every((entry) => entry.estimate)).toBe(true);
    });
    // Independent folders => their analyses overlapped instead of queueing.
    expect(peak()).toBe(2);
  });

  test("serializes tasks that share a branch-folder", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const createdA = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Login flow",
    });
    const createdB = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Logout flow",
    });
    const taskA = await moveToScheduled(createdA.id);
    const taskB = await moveToScheduled(createdB.id);
    const { estimator, peak } = buildConcurrencyProbe();

    estimator.requestEstimate("proj-1", taskA.id);
    estimator.requestEstimate("proj-1", taskB.id);

    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks.every((entry) => entry.estimate)).toBe(true);
    });
    // Same folder = one shared worktree, so the two analyses never overlapped.
    expect(peak()).toBe(1);
  });

  test("caps parallelism at maxConcurrent across independent tasks", async () => {
    const tasks = await Promise.all([
      scheduledTaskInFolder("A", "one"),
      scheduledTaskInFolder("B", "two"),
      scheduledTaskInFolder("C", "three"),
      scheduledTaskInFolder("D", "four"),
    ]);
    const { estimator, peak } = buildConcurrencyProbe(2);

    for (const task of tasks) {
      estimator.requestEstimate("proj-1", task.id);
    }

    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks.every((entry) => entry.estimate)).toBe(true);
    });
    // Four independent tasks, but the cap holds the peak at two at a time.
    expect(peak()).toBe(2);
  });
});
