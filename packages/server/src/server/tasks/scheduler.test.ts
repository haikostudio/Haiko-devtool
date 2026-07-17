import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { QuietHours } from "../quiet-hours.js";
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

  async function findTask(taskId: string): Promise<KanbanTask | undefined> {
    const board = await service.getBoard("proj-1");
    return board.tasks.find((entry) => entry.id === taskId);
  }

  async function seedScheduledTask(options?: {
    quotaPercent?: number;
    estimatedMinutes?: number;
    runConfig?: KanbanTask["runConfig"];
    approval?: KanbanTask["approval"];
    schedulePreference?: KanbanTask["schedulePreference"];
  }) {
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
        estimatedMinutes: options?.estimatedMinutes ?? 10,
        confidence: "medium" as const,
        model: "claude/haiku",
        estimatedAt: "2026-07-16T00:00:00.000Z",
      },
      schedule: { state: "awaiting_slot" as const, attempts: 0 },
      ...(options?.runConfig !== undefined ? { runConfig: options.runConfig } : {}),
      ...(options?.approval !== undefined ? { approval: options.approval } : {}),
      ...(options?.schedulePreference !== undefined
        ? { schedulePreference: options.schedulePreference }
        : {}),
    }));
    return task;
  }

  function buildScheduler(options: {
    remainingPct: number | null;
    runAgent?: () => Promise<{ canceled: boolean; finalText: string; timeline: [] }>;
    ghUrl?: string | null;
    quietHours?: QuietHours;
    nowMs?: number;
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
      // Default: always inside the launch window so quota-focused tests stay
      // independent of the wall clock.
      getQuietHours: () => options.quietHours ?? { startHour: 0, endHour: 24, timeZone: "UTC" },
      now: () => options.nowMs ?? Date.UTC(2026, 6, 17, 3, 0, 0),
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

  test("never launches a task awaiting user approval", async () => {
    await seedScheduledTask({ approval: { state: "pending", requestedBy: "agent-9" } });
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 90 });

    await scheduler.tick();

    expect(createAgent).not.toHaveBeenCalled();
    const board = await service.getBoard("proj-1");
    expect(board.tasks[0]?.column).toBe("scheduled");
    expect(board.tasks[0]?.approval?.state).toBe("pending");
  });

  test("runNow approves a pending proposal before launching", async () => {
    const task = await seedScheduledTask({ approval: { state: "pending" } });
    const { scheduler } = buildScheduler({ remainingPct: 90 });

    await scheduler.runNow("proj-1", task.id);

    await vi.waitFor(async () => {
      const entry = await findTask(task.id);
      expect(entry?.approval?.state).toBe("approved");
      expect(entry?.column).toBe("done");
    });
  });

  test("heavy task waits for quiet hours with a recorded reason, then launches in-window", async () => {
    const task = await seedScheduledTask({ quotaPercent: 40, estimatedMinutes: 120 });
    const daytime = Date.UTC(2026, 6, 17, 12, 0, 0);
    const nighttime = Date.UTC(2026, 6, 17, 3, 0, 0);
    const quietHours = { startHour: 1, endHour: 7, timeZone: "UTC" };

    const outside = buildScheduler({ remainingPct: 90, quietHours, nowMs: daytime });
    await outside.scheduler.tick();
    expect(outside.createAgent).not.toHaveBeenCalled();
    let board = await service.getBoard("proj-1");
    expect(board.tasks[0]?.schedule?.state).toBe("awaiting_slot");
    expect(board.tasks[0]?.schedule?.waitingReason).toBe("quiet_hours");

    const inside = buildScheduler({ remainingPct: 90, quietHours, nowMs: nighttime });
    await inside.scheduler.tick();
    await vi.waitFor(async () => {
      expect((await findTask(task.id))?.column).toBe("done");
    });
  });

  test("light task launches outside quiet hours in auto mode", async () => {
    await seedScheduledTask({ quotaPercent: 10, estimatedMinutes: 5 });
    const daytime = Date.UTC(2026, 6, 17, 12, 0, 0);
    const { scheduler, createAgent } = buildScheduler({
      remainingPct: 90,
      quietHours: { startHour: 1, endHour: 7, timeZone: "UTC" },
      nowMs: daytime,
    });

    await scheduler.tick();
    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalledTimes(1);
    });
  });

  test("a task without estimatedMinutes counts as heavy in auto mode", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Old estimate" });
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      estimate: {
        tokens: 50_000,
        quotaPercent: 5,
        confidence: "medium" as const,
        model: "claude/haiku",
        estimatedAt: "2026-07-16T00:00:00.000Z",
      },
      schedule: { state: "awaiting_slot" as const, attempts: 0 },
    }));
    const { scheduler, createAgent } = buildScheduler({
      remainingPct: 90,
      quietHours: { startHour: 1, endHour: 7, timeZone: "UTC" },
      nowMs: Date.UTC(2026, 6, 17, 12, 0, 0),
    });

    await scheduler.tick();

    expect(createAgent).not.toHaveBeenCalled();
    const board = await service.getBoard("proj-1");
    expect(board.tasks[0]?.schedule?.waitingReason).toBe("quiet_hours");
  });

  test("schedulePreference asap ignores quiet hours, off_peak always waits", async () => {
    const daytime = Date.UTC(2026, 6, 17, 12, 0, 0);
    const quietHours = { startHour: 1, endHour: 7, timeZone: "UTC" };

    const heavyAsap = await seedScheduledTask({
      quotaPercent: 40,
      estimatedMinutes: 120,
      schedulePreference: "asap",
    });
    const asap = buildScheduler({ remainingPct: 90, quietHours, nowMs: daytime });
    await asap.scheduler.tick();
    await vi.waitFor(async () => {
      expect((await findTask(heavyAsap.id))?.column).toBe("done");
    });

    const lightOffPeak = await seedScheduledTask({
      quotaPercent: 5,
      estimatedMinutes: 5,
      schedulePreference: "off_peak",
    });
    const offPeak = buildScheduler({ remainingPct: 90, quietHours, nowMs: daytime });
    await offPeak.scheduler.tick();
    const board = await service.getBoard("proj-1");
    const held = board.tasks.find((entry) => entry.id === lightOffPeak.id);
    expect(held?.column).toBe("scheduled");
    expect(held?.schedule?.waitingReason).toBe("quiet_hours");
  });

  test("createAgent receives provider, thinking, and plan mode from runConfig", async () => {
    const task = await seedScheduledTask({
      runConfig: {
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        mode: "plan",
      },
    });
    const { scheduler, createAgent } = buildScheduler({
      remainingPct: 90,
      runAgent: async () => ({ canceled: false, finalText: "Voici le plan…", timeline: [] }),
      ghUrl: null,
    });

    await scheduler.tick();
    await vi.waitFor(async () => {
      expect((await findTask(task.id))?.planReadyAt).toBeTruthy();
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex/gpt-5.4",
        thinking: "high",
        mode: "plan",
      }),
    );
    const board = await service.getBoard("proj-1");
    const planned = board.tasks.find((entry) => entry.id === task.id);
    // Plan runs finish without a PR: the card stays in progress for the user.
    expect(planned?.column).toBe("in_progress");
    expect(planned?.schedule ?? null).toBeNull();
    expect(planned?.links.prUrl ?? null).toBeNull();
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
