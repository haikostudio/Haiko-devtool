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

interface FakeCallerAgent {
  provider: string;
  config: { model?: string; thinkingOptionId?: string };
}

describe("paseo task board tools", () => {
  let dir: string;
  let service: TaskBoardService;
  let catalog: PaseoToolCatalog;
  let appended: { agentId: string; item: Record<string, unknown> }[];

  function buildCatalog(callerAgent: FakeCallerAgent | null): PaseoToolCatalog {
    return createPaseoToolCatalog({
      // Task tools only touch taskBoardService/projectRegistry plus the caller
      // lookup used to inherit its run config; the remaining dependencies are
      // inert stubs (their tools are never executed here). appendTimelineItem
      // captures the chat pills a proposal emits.
      agentManager: {
        listAgents: () => [],
        getAgent: () => callerAgent,
        appendTimelineItem: async (agentId: string, item: Record<string, unknown>) => {
          appended.push({ agentId, item });
        },
      } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      taskBoardService: service,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      callerAgentId: "agent-42",
      logger,
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-tools-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    appended = [];
    catalog = buildCatalog(null);
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

  test("create_task with proposeRun writes NOTHING to the board, only a chat proposal pill", async () => {
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

    // A proposal is not created on the board — it becomes a card only on approval.
    expect(result.column).toBe("proposed");
    expect(result.approvalState).toBe("pending");
    const board = await service.getBoard("proj-1");
    expect(board.tasks).toEqual([]);
    expect(board.folders).toEqual([]);

    // It surfaces as a chat pill in the caller's own thread, with the full payload
    // (and a proposalId, which the tool echoes back as its result id).
    expect(appended).toHaveLength(1);
    expect(appended[0]?.agentId).toBe("agent-42");
    const pill = appended[0]?.item as {
      type: string;
      status: string;
      tasks: { proposalId: string; title: string; folderName?: string; runConfig?: unknown }[];
    };
    expect(pill.type).toBe("task_triage");
    expect(pill.status).toBe("proposed");
    expect(pill.tasks).toHaveLength(1);
    expect(pill.tasks[0]).toMatchObject({
      proposalId: result.taskId,
      title: "Répondre au client sur la facturation",
      folderName: "Mail client",
      runConfig: { provider: "claude", model: "claude-opus-4-8", mode: "plan" },
    });
  });

  test("create_task with proposeRun but NO live caller falls back to a plain backlog card", async () => {
    // A top-level MCP caller (no thread) can't show a chat pill, so the proposal
    // degrades to a normal backlog task rather than being lost.
    const bare = createPaseoToolCatalog({
      agentManager: { listAgents: () => [], getAgent: () => null } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      taskBoardService: service,
      projectRegistry: fakeProjectRegistry([projectRecord("proj-1")]),
      logger,
    });
    const result = structured(
      await bare.executeTool("create_task", {
        projectId: "proj-1",
        title: "Nettoyer les logs",
        proposeRun: true,
      }),
    );
    expect(result.column).toBe("backlog");
    const board = await service.getBoard("proj-1");
    expect(board.tasks).toHaveLength(1);
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

  test("create_task without runConfig inherits the calling agent's engine", async () => {
    // A Codex conductor must produce Codex tasks — not tasks that silently fall
    // back to Claude at launch time.
    const codexCatalog = buildCatalog({
      provider: "codex",
      config: { model: "gpt-5.4", thinkingOptionId: "high" },
    });

    const result = structured(
      await codexCatalog.executeTool("create_task", {
        projectId: "proj-1",
        title: "Corriger le bandeau",
      }),
    );

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === result.taskId);
    expect(task?.runConfig).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });

  test("an explicit runConfig always wins over the calling agent's engine", async () => {
    const codexCatalog = buildCatalog({
      provider: "codex",
      config: { model: "gpt-5.4", thinkingOptionId: "high" },
    });

    const result = structured(
      await codexCatalog.executeTool("create_task", {
        projectId: "proj-1",
        title: "Tâche de code",
        runConfig: { provider: "claude", model: "claude-opus-4-8" },
      }),
    );

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === result.taskId);
    expect(task?.runConfig).toEqual({ provider: "claude", model: "claude-opus-4-8" });
  });

  test("create_task stays valid when the calling agent is gone", async () => {
    const result = structured(
      await catalog.executeTool("create_task", {
        projectId: "proj-1",
        title: "Sans agent appelant",
      }),
    );
    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === result.taskId);
    expect(task?.runConfig).toBeUndefined();
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

  test("move_task can never complete a card, even with a leftover check window", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });

    await expect(
      catalog.executeTool("move_task", { projectId: "proj-1", taskId: task.id, column: "done" }),
    ).rejects.toThrow(/only the user validates/);

    // Finishing a card is the user's own press now, so the old consent window is
    // gone: a card still carrying one (written by an older daemon) grants nothing.
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      validation: { state: "running" as const },
    }));
    await expect(
      catalog.executeTool("move_task", { projectId: "proj-1", taskId: task.id, column: "done" }),
    ).rejects.toThrow(/only the user validates/);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.column).toBe("backlog");
  });

  test("move_task still stamps a card deployed while the user's deploy is open", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      column: "done" as const,
      completedAt: new Date().toISOString(),
      deployment: { state: "running" as const },
    }));

    await catalog.executeTool("move_task", {
      projectId: "proj-1",
      taskId: task.id,
      column: "deployed",
    });

    // The move is authorized and stamps the card live; the board then files a
    // published card away on its own, so the live stamp is the honest assertion.
    const board = await service.getBoard("proj-1");
    expect(typeof board.tasks.find((entry) => entry.id === task.id)?.deployedAt).toBe("string");
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
