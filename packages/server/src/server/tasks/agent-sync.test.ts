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

// Synced cards are born in the backlog and STAY there: this service never moves
// a card between columns, whatever the agent reports.
function hasTwoBacklogTasks(board: { tasks: { column: string }[] }): boolean {
  return board.tasks.length === 2 && board.tasks.every((task) => task.column === "backlog");
}

// A checked-off todo must NOT complete the card, nor move it: it is only flagged
// as believed-finished, where it sits. Reaching "Terminée" requires the user to
// press the final-check bar.
function hasLoginFormTaskReadyForReview(board: {
  tasks: { normalizedTitle: string; column: string; progress?: string | null }[];
}): boolean {
  const task = board.tasks.find((entry) => entry.normalizedTitle === "implement the login form");
  return task?.column === "backlog" && task?.progress === "ready_for_review";
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

  test("creates cards in the Agent folder and flags a finished todo for review", async () => {
    emitTodos([
      { text: "Implement the login form", completed: false },
      { text: "Write the login tests", completed: false },
    ]);

    const board = await waitForBoard(hasTwoBacklogTasks);
    expect(board.folders.map((folder) => folder.name)).toEqual([AGENT_SYNC_FOLDER_NAME]);
    expect(board.tasks.every((task) => task.origin === "agent_sync")).toBe(true);

    emitTodos([
      { text: "Implement the login form", completed: true },
      { text: "Write the login tests", completed: false },
    ]);

    const board2 = await waitForBoard(hasLoginFormTaskReadyForReview);
    // The card is emphatically NOT completed, and it has not moved an inch —
    // only the user moves cards, only the final-check bar completes them.
    const done = board2.tasks.find((entry) => entry.normalizedTitle === "implement the login form");
    expect(done?.column).toBe("backlog");
    expect(done?.completedAt ?? null).toBeNull();
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

  // Regression: every card owns an agent from birth, and that agent runs the
  // title tidy-up seconds later. Before this guard, a brand-new "À faire" card
  // was dragged into "En cours" by its own tidy-up turn.
  test("ignores a card's own agent entirely", async () => {
    agents.set("agent-1", fakeAgent({ labels: { "paseo.task-id": "task-1" }, lifecycle: "idle" }));
    const folder = await service.createFolder("proj-1", "Backlog");
    const card = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Corriger l'affichage des batteries",
    });
    await service.patchTask("proj-1", card.id, (current) => ({
      ...current,
      links: { ...current.links, taskAgentId: "agent-1", agentIds: ["agent-1"] },
    }));

    subscriber({ type: "agent_state", agent: agents.get("agent-1") as ManagedAgent });
    subscriber({
      type: "agent_state",
      agent: fakeAgent({ labels: { "paseo.task-id": "task-1" }, lifecycle: "running" }),
    });
    emitTodos([{ text: "Implement the login form", completed: false }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const board = await service.getBoard("proj-1");
    // The card stays put, and no parasite card is minted in an "Agent" folder.
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]?.column).toBe("backlog");
  });

  test("never moves a task awaiting user approval", async () => {
    const folder = await service.createFolder("proj-1", AGENT_SYNC_FOLDER_NAME);
    const pending = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Implement the login form",
      approval: { state: "pending", requestedBy: "agent-1" },
    });
    // A proposal is born in backlog with its pending marker. Dedupe links the
    // emitting agent onto the existing card; the approval guard must still keep
    // the card parked where it is — agent-sync never drags a pending proposal.
    emitTodos([{ text: "Implement the login form", completed: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const board = await service.getBoard("proj-1");
    const task = board.tasks.find((entry) => entry.id === pending.id);
    expect(board.tasks).toHaveLength(1);
    expect(task?.column).toBe("backlog");
    expect(task?.approval?.state).toBe("pending");
  });
});
