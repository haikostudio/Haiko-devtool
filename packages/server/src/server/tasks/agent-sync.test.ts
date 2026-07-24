import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentManager, AgentSubscriber, ManagedAgent } from "../agent/agent-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import {
  AGENT_SYNC_FOLDER_NAME,
  AgentTaskSyncService,
  extractTrackableItems,
} from "./agent-sync.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

function fakeAgent(overrides: Partial<ManagedAgent>): ManagedAgent {
  return {
    id: "agent-1",
    workspaceId: "ws-1",
    lifecycle: "running",
    // A real ManagedAgent always carries a (possibly empty) permissions map; the
    // sync's "awaiting user" guard reads its size.
    pendingPermissions: new Map(),
    ...overrides,
  } as ManagedAgent;
}

function fakeWorkspaceRegistry(records: Record<string, string>): WorkspaceRegistry {
  return {
    get: async (workspaceId: string) =>
      records[workspaceId]
        ? ({ workspaceId, projectId: records[workspaceId] } as PersistedWorkspaceRecord)
        : null,
  } as WorkspaceRegistry;
}

describe("extractTrackableItems", () => {
  test("filters short and generic items", () => {
    const items = extractTrackableItems([
      { text: "fix", completed: false },
      { text: "done", completed: true },
      { text: "Implement the login form", completed: false },
      { text: "  - [ ] Add e2e coverage for auth ", completed: true },
    ]);
    expect(items).toEqual([
      { title: "Implement the login form", completed: false },
      { title: "- [ ] Add e2e coverage for auth", completed: true },
    ]);
  });
});

function hasTwoInProgressTasks(board: { tasks: { column: string }[] }): boolean {
  return board.tasks.length === 2 && board.tasks.every((task) => task.column === "in_progress");
}

function hasLoginFormTaskDone(board: {
  tasks: { normalizedTitle: string; column: string }[];
}): boolean {
  const task = board.tasks.find((entry) => entry.normalizedTitle === "implement the login form");
  return task?.column === "done";
}

describe("AgentTaskSyncService", () => {
  let dir: string;
  let service: TaskBoardService;
  let subscriber: AgentSubscriber;
  let sync: AgentTaskSyncService;
  let agents: Map<string, ManagedAgent>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-sync-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    agents = new Map([["agent-1", fakeAgent({})]]);
    const agentManager = {
      subscribe: (callback: AgentSubscriber) => {
        subscriber = callback;
        return () => {};
      },
      getAgent: (id: string) => agents.get(id) ?? null,
    } as unknown as AgentManager;
    sync = new AgentTaskSyncService({
      agentManager,
      workspaceRegistry: fakeWorkspaceRegistry({ "ws-1": "proj-1" }),
      taskBoardService: service,
      logger,
    });
    sync.start();
  });

  afterEach(async () => {
    sync.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function emitTodos(items: { text: string; completed: boolean }[]): void {
    // Sync handlers are fire-and-forget; assertions below poll with vi.waitFor.
    subscriber({
      type: "agent_stream",
      agentId: "agent-1",
      event: { type: "timeline", item: { type: "todo", items }, provider: "claude" },
    });
  }

  async function waitForBoard(
    predicate: (board: Awaited<ReturnType<TaskBoardService["getBoard"]>>) => boolean,
  ) {
    await vi.waitFor(async () => {
      expect(predicate(await service.getBoard("proj-1"))).toBe(true);
    });
    return service.getBoard("proj-1");
  }

  test("creates cards in the Agent folder from todo items and tracks completion", async () => {
    emitTodos([
      { text: "Implement the login form", completed: false },
      { text: "Write the login tests", completed: false },
    ]);

    const board = await waitForBoard(hasTwoInProgressTasks);
    expect(board.folders.map((folder) => folder.name)).toEqual([AGENT_SYNC_FOLDER_NAME]);
    expect(board.tasks.every((task) => task.origin === "agent_sync")).toBe(true);

    emitTodos([
      { text: "Implement the login form", completed: true },
      { text: "Write the login tests", completed: false },
    ]);

    await waitForBoard(hasLoginFormTaskDone);
  });

  test("ignores agents without a project workspace", async () => {
    agents.set("agent-1", fakeAgent({ workspaceId: undefined }));
    emitTodos([{ text: "Implement the login form", completed: false }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const board = await service.getBoard("proj-1");
    expect(board.tasks).toHaveLength(0);
  });

  test("does not fight manual column overrides", async () => {
    emitTodos([{ text: "Implement the login form", completed: false }]);
    let board = await waitForBoard((current) => current.tasks.length === 1);
    const task = board.tasks[0];
    if (!task) throw new Error("expected a synced task");
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "backlog",
      index: 0,
      manual: true,
    });

    emitTodos([{ text: "Implement the login form", completed: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    board = await service.getBoard("proj-1");
    expect(board.tasks[0]?.column).toBe("backlog");
  });

  test("never completes a task while its agent is blocked on a permission", async () => {
    // Card exists in progress; the agent then hits a permission prompt.
    emitTodos([{ text: "Implement the login form", completed: false }]);
    await waitForBoard((current) => current.tasks[0]?.column === "in_progress");
    agents.set("agent-1", fakeAgent({ pendingPermissions: new Map([["req-1", {} as never]]) }));

    // The same todo now reports done — but the pending permission must keep the
    // card in progress rather than burying the prompt under a terminal "done".
    emitTodos([{ text: "Implement the login form", completed: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const board = await service.getBoard("proj-1");
    expect(board.tasks[0]?.column).toBe("in_progress");
  });

  test("reopens a finished card when its agent starts executing again", async () => {
    // Drive the card to "done" through a completed todo.
    emitTodos([{ text: "Implement the login form", completed: true }]);
    const doneBoard = await waitForBoard(hasLoginFormTaskDone);
    expect(doneBoard.tasks[0]?.completedAt).toBeTruthy();

    // The agent picks the work back up (lifecycle → running): the card must
    // reopen to "in_progress" and shed its completion stamp so it reads as live.
    subscriber({ type: "agent_state", agent: fakeAgent({ lifecycle: "running" }) });
    const reopened = await waitForBoard((current) => current.tasks[0]?.column === "in_progress");
    expect(reopened.tasks[0]?.completedAt ?? null).toBeNull();
  });

  test("never moves a task awaiting user approval", async () => {
    const folder = await service.createFolder("proj-1", AGENT_SYNC_FOLDER_NAME);
    const pending = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Implement the login form",
      column: "scheduled",
      approval: { state: "pending", requestedBy: "agent-1" },
    });
    // Dedupe links the emitting agent onto the existing card; the approval
    // guard must still keep the card parked in "scheduled".
    emitTodos([{ text: "Implement the login form", completed: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === pending.id);
    expect(board.tasks).toHaveLength(1);
    expect(task?.column).toBe("scheduled");
    expect(task?.approval?.state).toBe("pending");
  });
});
