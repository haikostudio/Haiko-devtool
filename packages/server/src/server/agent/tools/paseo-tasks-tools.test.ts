import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PersistedProjectRecord, ProjectRegistry } from "../../workspace-registry.js";
import { TaskBoardService } from "../../tasks/service.js";
import { TaskBoardStore } from "../../tasks/store.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolCatalog } from "./types.js";

const logger = pino({ level: "silent" });

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

function fakeProjectRegistry(records: PersistedProjectRecord[]): ProjectRegistry {
  return {
    list: async () => records,
    get: async (projectId: string) =>
      records.find((record) => record.projectId === projectId) ?? null,
  } as ProjectRegistry;
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("paseo task board tools", () => {
  let dir: string;
  let service: TaskBoardService;
  let catalog: PaseoToolCatalog;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-tools-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    catalog = createPaseoToolCatalog({
      // Task tools only touch taskBoardService/projectRegistry; the remaining
      // dependencies are inert stubs (their tools are never executed here).
      agentManager: { listAgents: () => [] } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      taskBoardService: service,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      callerAgentId: "agent-42",
      logger,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("tools are absent when the task board service is not provided", () => {
    const bare = createPaseoToolCatalog({
      agentManager: { listAgents: () => [] } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      logger,
    });
    expect(bare.getTool("create_task")).toBeUndefined();
    expect(bare.getTool("list_task_boards")).toBeUndefined();
  });

  test("there is deliberately no approve tool — approval is user-only", () => {
    expect(catalog.getTool("approve_task")).toBeUndefined();
  });

  test("list_task_boards returns projects with folders and counts", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });

    const result = structured(await catalog.executeTool("list_task_boards", {}));
    expect(result.boards).toEqual([
      expect.objectContaining({
        projectId: "proj-1",
        rootPath: "/tmp/proj-1",
        folders: [expect.objectContaining({ name: "Auth", taskCount: 1 })],
      }),
    ]);
  });

  test("create_task with proposeRun lands in backlog awaiting validation, unlinked from the caller", async () => {
    const result = structured(
      await catalog.executeTool("create_task", {
        projectId: "proj-1",
        folderName: "Mail client",
        title: "Répondre au client sur la facturation",
        description: "Voir le mail du 17/07",
        runConfig: { provider: "claude", model: "claude-opus-4-8", mode: "plan" },
        schedulePreference: "off_peak",
        proposeRun: true,
      }),
    );

    // Every new task is born in backlog — a proposal never enters the pipeline
    // at creation. The pending marker is what flags it for the user's validation.
    expect(result.column).toBe("backlog");
    expect(result.approvalState).toBe("pending");

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === result.taskId);
    expect(task?.column).toBe("backlog");
    expect(task?.approval?.state).toBe("pending");
    expect(task?.approval?.requestedBy).toBe("agent-42");
    expect(task?.runConfig?.mode).toBe("plan");
    expect(task?.schedulePreference).toBe("off_peak");
    // The proposer must NOT be linked: agent-sync would drag the card around.
    expect(task?.links.agentIds).toEqual([]);
    // Backlog tasks are inert: the schedule stays disarmed until the user
    // validates the proposal (moves it into the pipeline).
    expect(task?.schedule).toBeUndefined();
    expect(board.folders.some((folder) => folder.name === "Mail client")).toBe(true);
  });

  test("create_task without proposeRun lands in backlog without approval", async () => {
    const result = structured(
      await catalog.executeTool("create_task", {
        projectId: "proj-1",
        title: "Nettoyer les logs",
      }),
    );
    expect(result.column).toBe("backlog");
    expect(result.approvalState).toBeUndefined();
    const board = await service.getBoard("proj-1");
    expect(board.folders.some((folder) => folder.name === "Agent")).toBe(true);
  });

  test("list_tasks filters by column and update_task patches runConfig", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    // Tasks are born in backlog; move the second one into the pipeline so the
    // column filter has something to distinguish from backlog.
    const scheduled = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Scheduled one",
    });
    await service.transitionTask("proj-1", scheduled.id, "scheduled");

    const backlog = structured(
      await catalog.executeTool("list_tasks", { projectId: "proj-1", column: "backlog" }),
    );
    expect(backlog.tasks).toHaveLength(1);

    await catalog.executeTool("update_task", {
      projectId: "proj-1",
      taskId: task.id,
      runConfig: { provider: "codex", model: "gpt-5.4", thinkingOptionId: "high" },
    });
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.runConfig?.provider).toBe("codex");
  });

  test("move_task refuses every column the user owns", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });

    for (const column of ["validated", "scheduled", "in_progress", "done", "deployed"]) {
      await expect(
        catalog.executeTool("move_task", { projectId: "proj-1", taskId: task.id, column }),
      ).rejects.toThrow(/only the user validates/);
    }

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.column).toBe("backlog");
  });

  test("move_task completes a card only while the user's final check is open", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });

    await expect(
      catalog.executeTool("move_task", { projectId: "proj-1", taskId: task.id, column: "done" }),
    ).rejects.toThrow(/only the user validates/);

    // The user pressed "Lancer le contrôle": that press is the consent.
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      validation: { state: "running" as const },
    }));
    await catalog.executeTool("move_task", {
      projectId: "proj-1",
      taskId: task.id,
      column: "done",
    });
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.column).toBe("done");

    // Still no free pass to the other user-owned columns.
    await expect(
      catalog.executeTool("move_task", {
        projectId: "proj-1",
        taskId: task.id,
        column: "deployed",
      }),
    ).rejects.toThrow(/only the user validates/);
  });

  test("move_task still shuffles a card between notes and backlog", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });

    await catalog.executeTool("move_task", {
      projectId: "proj-1",
      taskId: task.id,
      column: "notes",
    });

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.column).toBe("notes");
  });
});
