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

  async function seedScheduledTask() {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Implement login flow",
      column: "scheduled",
    });
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
    // Not an internal throwaway agent, and it runs in its own worktree.
    expect(createCall).not.toHaveProperty("internal");
    expect(createCall).toHaveProperty("title", "Tâche : Implement login flow");
    expect(createCall).toHaveProperty("worktree.action", "branch-off");
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
});
