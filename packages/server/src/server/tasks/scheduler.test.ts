import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { QuietHours } from "../quiet-hours.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";
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

  async function countQuotaWaiting(): Promise<number> {
    const board = await service.getBoard("proj-1");
    return board.tasks.filter((task) => task.schedule?.waitingReason === "quota").length;
  }

  async function seedScheduledTask(options?: {
    title?: string;
    quotaPercent?: number;
    estimatedMinutes?: number;
    runConfig?: KanbanTask["runConfig"];
    approval?: KanbanTask["approval"];
    schedulePreference?: KanbanTask["schedulePreference"];
  }) {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: options?.title ?? "Implement login flow",
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
    quietHours?: QuietHours;
    nowMs?: number;
  }) {
    const createAgent = vi.fn(async () => ({
      snapshot: { id: "task-agent-1", workspaceId: "ws-proj-1", cwd: "/tmp/wt/feat-auth" },
      initialPromptError: null,
    }));
    const runAgent =
      options.runAgent ??
      (async () => ({
        canceled: false,
        finalText: "Done!",
        timeline: [] as [],
      }));
    const estimator = { requestEstimate: vi.fn() } as unknown as TaskEstimator;
    const scheduler = new TaskScheduler({
      taskBoardService: service,
      taskEstimator: estimator,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      agentManager: { runAgent } as never,
      createAgent: createAgent as never,
      providerUsageService: usageWithRemaining(options.remainingPct),
      logger,
      // Default: always inside the launch window so quota-focused tests stay
      // independent of the wall clock.
      getQuietHours: () => options.quietHours ?? { startHour: 0, endHour: 24, timeZone: "UTC" },
      now: () => options.nowMs ?? Date.UTC(2026, 6, 17, 3, 0, 0),
    });
    return { scheduler, createAgent, estimator };
  }

  test("launches an awaiting task in an isolated worktree and marks it done", async () => {
    const task = await seedScheduledTask({ quotaPercent: 15 });
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 80 });

    await scheduler.tick();
    await vi.waitFor(async () => {
      const board = await service.getBoard("proj-1");
      expect(board.tasks[0]?.column).toBe("done");
    });

    const board = await service.getBoard("proj-1");
    const done = board.tasks.find((entry) => entry.id === task.id);
    expect(done?.links.primaryAgentId).toBe("task-agent-1");
    expect(done?.links.workspaceId).toBe("ws-proj-1");
    // A folder IS a git branch: the task lands on the folder's branch (derived
    // from the "Auth" folder name), shared by all of the folder's tasks.
    expect(done?.links.branch).toBe("feat/auth");
    expect(done?.links.prUrl ?? null).toBeNull();
    expect(done?.schedule ?? null).toBeNull();
    // The shared worktree is recorded on the folder for its later tasks to reuse.
    const authFolder = board.folders.find((entry) => entry.branch === "feat/auth");
    expect(authFolder?.workspaceId).toBe("ws-proj-1");
    expect(createAgent).toHaveBeenCalledTimes(1);
    // Runs in a fresh worktree branched off the project checkout on that branch.
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/proj-1",
        worktree: expect.objectContaining({
          action: "branch-off",
          branchName: "feat/auth",
        }),
      }),
    );
  });

  test("reuses the analysis agent for execution instead of creating a new one", async () => {
    const task = await seedScheduledTask({ quotaPercent: 15 });
    // Simulate the analysis phase having already spawned the task's visible
    // agent in its worktree: execution must CONTINUE that same conversation.
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      links: {
        ...current.links,
        taskAgentId: "analysis-agent-7",
        primaryAgentId: "analysis-agent-7",
        agentIds: ["analysis-agent-7"],
        workspaceId: "ws-existing",
        branch: "task/reuse-me",
      },
    }));
    const runAgent = vi.fn(async () => ({
      canceled: false,
      finalText: "Done!",
      timeline: [] as [],
    }));
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 80, runAgent });

    await scheduler.tick();
    await vi.waitFor(async () => {
      expect((await findTask(task.id))?.column).toBe("done");
    });

    // No new agent: the same analysis agent runs the execution turn.
    expect(createAgent).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
    const done = await findTask(task.id);
    expect(done?.links.primaryAgentId).toBe("analysis-agent-7");
    expect(done?.links.taskAgentId).toBe("analysis-agent-7");
    expect(done?.links.branch).toBe("task/reuse-me");
  });

  test("does not launch a held task (pause au choix), then launches once run-now lifts the hold", async () => {
    const task = await seedScheduledTask({ quotaPercent: 10 });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      executionHold: true,
    }));
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 90 });

    await scheduler.tick();
    // Held: analyzed and awaiting, but never auto-launched.
    expect(createAgent).not.toHaveBeenCalled();
    let held = await findTask(task.id);
    expect(held?.column).toBe("scheduled");
    expect(held?.executionHold).toBe(true);

    // An explicit run-now is the user's "go": it lifts the hold and launches.
    await scheduler.runNow("proj-1", task.id);
    await vi.waitFor(async () => {
      expect((await findTask(task.id))?.column).toBe("done");
    });
    held = await findTask(task.id);
    expect(held?.executionHold ?? false).toBe(false);
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

  test("auto-re-queues a canceled run without a lasting error or a spent attempt", async () => {
    const task = await seedScheduledTask();
    const { scheduler } = buildScheduler({
      remainingPct: 90,
      runAgent: async () => ({ canceled: true, finalText: "", timeline: [] }),
    });

    await scheduler.tick();
    const findState = async () => {
      const board = await service.getBoard("proj-1");
      return board.tasks.find((entry) => entry.id === task.id)?.schedule;
    };
    await vi.waitFor(async () => {
      expect((await findState())?.cancelRequeues).toBe(1);
    });

    const board = await service.getBoard("proj-1");
    const requeued = board.tasks.find((entry) => entry.id === task.id);
    // Re-queued for the next slot, no red error, and no real attempt burned.
    expect(requeued?.column).toBe("scheduled");
    expect(requeued?.schedule?.state).toBe("awaiting_slot");
    expect(requeued?.schedule?.attempts).toBe(0);
    expect(requeued?.schedule?.lastError).toBeFalsy();
  });

  test("gives up on a task that keeps getting canceled", async () => {
    const task = await seedScheduledTask();
    const { scheduler } = buildScheduler({
      remainingPct: 90,
      runAgent: async () => ({ canceled: true, finalText: "", timeline: [] }),
    });

    const findState = async () => {
      const board = await service.getBoard("proj-1");
      return board.tasks.find((entry) => entry.id === task.id)?.schedule;
    };
    // Keep ticking; each canceled run re-queues to awaiting_slot until the
    // re-queue budget (MAX_CANCEL_REQUEUES = 5) is spent and it lands "failed".
    await vi.waitFor(
      async () => {
        await scheduler.tick();
        expect((await findState())?.state).toBe("failed");
      },
      { timeout: 5000, interval: 50 },
    );

    expect((await findState())?.lastError).toContain("canceled");
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
    // Plan runs make no changes, so they get no throwaway worktree.
    expect(createAgent.mock.calls[0]?.[0]).not.toHaveProperty("worktree");
    const board = await service.getBoard("proj-1");
    const planned = board.tasks.find((entry) => entry.id === task.id);
    // Plan runs finish without a PR: the card stays in progress for the user.
    expect(planned?.column).toBe("in_progress");
    expect(planned?.schedule ?? null).toBeNull();
    expect(planned?.links.prUrl ?? null).toBeNull();
  });

  test("autopilot folder: backlog task auto-validates then launches", async () => {
    const folder = await service.createFolder("proj-1", "Auto", undefined, true);
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Autopilot me",
    });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      estimate: {
        tokens: 50_000,
        quotaPercent: 8,
        estimatedMinutes: 10,
        confidence: "medium" as const,
        model: "claude/haiku",
        estimatedAt: "2026-07-16T00:00:00.000Z",
      },
    }));
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 80 });

    // Autopilot is the folder-level consent: the scheduler moves the backlog task
    // into "Validé" itself, and from there the pipeline runs to completion. This
    // takes several ticks (backlog → validated → scheduled → launch → done).
    await vi.waitFor(async () => {
      await scheduler.tick();
      expect((await findTask(task.id))?.column).toBe("done");
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  test("non-autopilot backlog task is inert: never estimated, never launched", async () => {
    const folder = await service.createFolder("proj-1", "Manual");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Sit in backlog",
    });
    const { scheduler, createAgent, estimator } = buildScheduler({ remainingPct: 80 });

    // Backlog is the un-validated staging area: no analysis and no execution
    // happen until the user moves the task into "Validé".
    await scheduler.tick();
    expect(estimator.requestEstimate).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();

    await scheduler.tick();
    expect(estimator.requestEstimate).not.toHaveBeenCalled();
    expect((await findTask(task.id))?.column).toBe("backlog");
  });

  test("quiet hours pack the biggest estimated task first when quota is tight", async () => {
    const big = await seedScheduledTask({ title: "Big migration", quotaPercent: 30 });
    const small = await seedScheduledTask({ title: "Tiny tweak", quotaPercent: 5 });
    // 42% remaining: the big task fits (30 + 10 margin), and once its 30% is
    // reserved the small one no longer does (12 < 5 + 10).
    const { scheduler, createAgent } = buildScheduler({
      remainingPct: 42,
      quietHours: { startHour: 1, endHour: 7, timeZone: "UTC" },
      nowMs: Date.UTC(2026, 6, 17, 3, 0, 0),
    });

    await scheduler.tick();
    await vi.waitFor(async () => {
      expect((await findTask(big.id))?.column).toBe("done");
    });

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Tâche : Big migration" }),
    );
    const held = await findTask(small.id);
    expect(held?.column).toBe("scheduled");
    expect(held?.schedule?.waitingReason).toBe("quota");
  });

  test("during the day the lightest task goes first", async () => {
    await seedScheduledTask({ title: "Big migration", quotaPercent: 30, estimatedMinutes: 120 });
    const small = await seedScheduledTask({
      title: "Tiny tweak",
      quotaPercent: 5,
      estimatedMinutes: 5,
    });
    const { scheduler, createAgent } = buildScheduler({
      remainingPct: 42,
      quietHours: { startHour: 1, endHour: 7, timeZone: "UTC" },
      nowMs: Date.UTC(2026, 6, 17, 12, 0, 0),
    });

    await scheduler.tick();
    await vi.waitFor(async () => {
      expect((await findTask(small.id))?.column).toBe("done");
    });

    // Only the light task runs during the day; the heavy one waits for night.
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Tâche : Tiny tweak" }),
    );
  });

  // Keeps every launch in flight (never resolves) so quota reservations stay
  // held for the whole tick — makes the parallel-launch counts deterministic.
  const hangingRun = () =>
    new Promise<{ canceled: boolean; finalText: string; timeline: [] }>(() => {});

  test("runs many tiny tasks in parallel — concurrency scales with size, not a fixed 2", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedScheduledTask({ title: `Tiny ${i}`, quotaPercent: 4, estimatedMinutes: 5 });
    }
    // 90% remaining easily covers 5 × 4% (+10% margin each), and 5 is under the
    // machine ceiling, so all five launch at once — no per-project serialization.
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 90, runAgent: hangingRun });

    await scheduler.tick();
    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalledTimes(5);
    });
  });

  test("stops launching tiny tasks once the quota budget is spent", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedScheduledTask({ title: `Tiny ${i}`, quotaPercent: 8, estimatedMinutes: 5 });
    }
    // 30% remaining: first task reserves 8 (needs 8+10), then 22 left covers one
    // more (needs 18), then 14 left < 18 — so exactly 2 launch, quota-limited.
    const { scheduler, createAgent } = buildScheduler({ remainingPct: 30, runAgent: hangingRun });

    await scheduler.tick();
    await vi.waitFor(async () => {
      expect(await countQuotaWaiting()).toBe(3);
    });
    expect(createAgent).toHaveBeenCalledTimes(2);
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
