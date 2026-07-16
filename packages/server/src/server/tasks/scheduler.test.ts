import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import { TaskScheduler } from "./scheduler.js";
import type { TaskEstimator } from "./estimator.js";

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

function usageWithRemaining(remainingPct: number | null) {
  return {
    listUsage: async () => ({
      fetchedAt: "2026-07-16T00:00:00.000Z",
      providers: [
        {
          providerId: "claude",
          displayName: "Claude",
          status: "available" as const,
          planLabel: "Max",
          windows: [
            {
              id: "five_hour",
              label: "Session",
              ...(remainingPct !== null
                ? { usedPct: 100 - remainingPct, remainingPct }
                : { usedPct: null, remainingPct: null }),
              resetsAt: null,
            },
          ],
          balances: [],
          error: null,
        },
      ],
    }),
  };
}

describe("TaskScheduler", () => {
  let dir: string;
  let service: TaskBoardService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-sched-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedScheduledTask(options?: { quotaPercent?: number }) {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Implement login flow",
    });
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      estimate: {
        tokens: 100_000,
        quotaPercent: options?.quotaPercent ?? 15,
        confidence: "medium" as const,
        model: "claude/haiku",
        estimatedAt: "2026-07-16T00:00:00.000Z",
      },
      schedule: { state: "awaiting_slot" as const, attempts: 0 },
    }));
    return task;
  }

  function buildScheduler(options: {
    remainingPct: number | null;
    runAgent?: () => Promise<{ canceled: boolean; finalText: string; timeline: [] }>;
    ghUrl?: string | null;
  }) {
    const createWorktree = vi.fn(async () => ({
      workspace: {
        workspaceId: "ws-task",
        projectId: "proj-1",
        cwd: "/tmp/proj-1-wt",
        kind: "worktree",
        displayName: "wt",
        title: null,
        branch: "task/abc-implement-login-flow",
        baseBranch: "main",
        createdAt: "",
        updatedAt: "",
        archivedAt: null,
        pinnedAt: null,
      },
    })) as unknown as () => Promise<CreatePaseoWorktreeWorkflowResult>;
    const createAgent = vi.fn(async () => ({
      snapshot: { id: "task-agent-1" },
      initialPromptError: null,
    }));
    const runAgent =
      options.runAgent ??
      (async () => ({
        canceled: false,
        finalText: "Done!\nhttps://github.com/acme/repo/pull/42",
        timeline: [] as [],
      }));
    const estimator = { requestEstimate: vi.fn() } as unknown as TaskEstimator;
    const scheduler = new TaskScheduler({
      taskBoardService: service,
      taskEstimator: estimator,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      agentManager: { runAgent } as never,
      createAgent: createAgent as never,
      createPaseoWorktreeWorkspace: createWorktree,
      providerUsageService: usageWithRemaining(options.remainingPct),
      logger,
      execGhPrViewUrl: async () => options.ghUrl ?? null,
    });
    return { scheduler, createWorktree, createAgent, estimator };
  }

  test("launches an awaiting task when quota allows and records the PR", async () => {
    const task = await seedScheduledTask({ quotaPercent: 15 });
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 80 });

    await scheduler.tick();
    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks[0]?.column).toBe("done");
    });

    const board = await service.getBoard("proj-1");
    const done = board.tasks.find((entry) => entry.id === task.id);
    expect(done?.links.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(done?.links.primaryAgentId).toBe("task-agent-1");
    expect(done?.schedule ?? null).toBeNull();
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  test("defers launch when remaining quota is below estimate + margin", async () => {
    await seedScheduledTask({ quotaPercent: 50 });
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 40 });

    await scheduler.tick();

    expect(createAgent).not.toHaveBeenCalled();
    const board = await service.getBoard("proj-1");
    expect(board.tasks[0]?.column).toBe("scheduled");
    expect(board.tasks[0]?.schedule?.state).toBe("awaiting_slot");
  });

  test("returns the task to awaiting_slot with an error when no PR is produced", async () => {
    const task = await seedScheduledTask();
    const { scheduler } = buildScheduler({
      remainingPct: 90,
      runAgent: async () => ({ canceled: false, finalText: "Could not push", timeline: [] }),
      ghUrl: null,
    });

    await scheduler.tick();
    const findScheduleError = async () => {
      const board = await service.getBoard("proj-1");
      return board.tasks.find((entry) => entry.id === task.id)?.schedule?.lastError;
    };
    await vi.waitFor(async () => {
      expect(await findScheduleError()).toBeTruthy();
    });

    const board = await service.getBoard("proj-1");
    const failed = board.tasks.find((entry) => entry.id === task.id);
    expect(failed?.column).toBe("scheduled");
    expect(failed?.schedule?.attempts).toBe(1);
    expect(failed?.schedule?.lastError).toContain("pull request");
  });

  test("re-arms estimation for pending_estimate tasks after a restart", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Needs estimate first",
    });
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });
    const { scheduler, estimator, createAgent } = buildScheduler({ remainingPct: 90 });

    await scheduler.tick();

    expect(estimator.requestEstimate).toHaveBeenCalledWith("proj-1", task.id);
    expect(createAgent).not.toHaveBeenCalled();
  });
});
