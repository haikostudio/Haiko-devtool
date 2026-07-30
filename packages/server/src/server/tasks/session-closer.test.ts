import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import {
  TaskSessionCloser,
  type TaskSessionCloserOptions,
  collectTaskAgentIds,
  isTaskArchived,
} from "./session-closer.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

type Lifecycle = "idle" | "running" | "closed" | "error";

interface FakeAgent {
  id: string;
  lifecycle: Lifecycle;
}

// Minimal stand-in for AgentManager: only the three doors the closer uses, plus
// the state feed watchAgentIdle subscribes to.
function buildAgentHost(agents: FakeAgent[], stored: Array<{ id: string; archivedAt?: string }>) {
  const live = new Map(agents.map((agent) => [agent.id, agent]));
  const records = new Map(stored.map((record) => [record.id, { ...record }]));
  const listeners = new Set<(event: { type: string; agent: FakeAgent }) => void>();
  const archived: string[] = [];
  const archivedSnapshots: string[] = [];
  return {
    archived,
    archivedSnapshots,
    emitState(agentId: string, lifecycle: Lifecycle) {
      const agent = live.get(agentId);
      if (agent) {
        agent.lifecycle = lifecycle;
      }
      for (const listener of listeners) {
        listener({ type: "agent_state", agent: { id: agentId, lifecycle } });
      }
    },
    manager: {
      getAgent: (agentId: string) => live.get(agentId) ?? null,
      subscribe: (listener: (event: { type: string; agent: FakeAgent }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      archiveAgent: async (agentId: string) => {
        archived.push(agentId);
        live.delete(agentId);
        return { archivedAt: "2026-07-30T00:00:00.000Z" };
      },
      archiveSnapshot: async (agentId: string) => {
        archivedSnapshots.push(agentId);
        return { id: agentId };
      },
    },
    storage: {
      get: async (agentId: string) => records.get(agentId) ?? null,
    },
  };
}

type AgentHost = TaskSessionCloserOptions["agentManager"];
type StorageHost = TaskSessionCloserOptions["agentStorage"];

function asAgentHost(host: ReturnType<typeof buildAgentHost>["manager"]): AgentHost {
  return host as unknown as AgentHost;
}

function asStorageHost(host: ReturnType<typeof buildAgentHost>["storage"]): StorageHost {
  return host as unknown as StorageHost;
}

describe("collectTaskAgentIds", () => {
  test("gathers every agent a card owns, once each, task agent first", () => {
    const task = {
      links: {
        agentIds: ["agent-old", "agent-task"],
        primaryAgentId: "agent-task",
        taskAgentId: "agent-task",
      },
    } as unknown as KanbanTask;
    expect(collectTaskAgentIds(task)).toEqual(["agent-task", "agent-old"]);
  });

  test("ignores blank ids", () => {
    const task = {
      links: { agentIds: ["", "  "], primaryAgentId: null, taskAgentId: null },
    } as unknown as KanbanTask;
    expect(collectTaskAgentIds(task)).toEqual([]);
  });
});

describe("isTaskArchived", () => {
  test("covers both doors: the terminal column and the manual hide", () => {
    expect(isTaskArchived({ column: "archived" } as KanbanTask)).toBe(true);
    expect(
      isTaskArchived({ column: "done", archivedAt: "2026-07-30T00:00:00.000Z" } as KanbanTask),
    ).toBe(true);
    expect(isTaskArchived({ column: "done" } as KanbanTask)).toBe(false);
  });
});

describe("TaskSessionCloser", () => {
  test("archives an idle agent right away", async () => {
    const host = buildAgentHost([{ id: "agent-1", lifecycle: "idle" }], []);
    const closer = new TaskSessionCloser({
      agentManager: asAgentHost(host.manager),
      agentStorage: asStorageHost(host.storage),
      logger,
    });

    await closer.closeSessionsForTask("proj-1", {
      id: "task-1",
      links: { agentIds: [], taskAgentId: "agent-1" },
    } as unknown as KanbanTask);

    expect(host.archived).toEqual(["agent-1"]);
  });

  test("waits for a running agent to fall silent before closing it", async () => {
    const host = buildAgentHost([{ id: "agent-1", lifecycle: "running" }], []);
    const closer = new TaskSessionCloser({
      agentManager: asAgentHost(host.manager),
      agentStorage: asStorageHost(host.storage),
      logger,
    });

    await closer.closeSessionsForTask("proj-1", {
      id: "task-1",
      links: { agentIds: [], taskAgentId: "agent-1" },
    } as unknown as KanbanTask);

    // Still talking: nothing is cut off mid-reply.
    expect(host.archived).toEqual([]);

    host.emitState("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));

    expect(host.archived).toEqual(["agent-1"]);
    closer.dispose();
  });

  test("archives the stored record of an agent this daemon never resumed", async () => {
    const host = buildAgentHost([], [{ id: "agent-old" }]);
    const closer = new TaskSessionCloser({
      agentManager: asAgentHost(host.manager),
      agentStorage: asStorageHost(host.storage),
      logger,
    });

    await closer.closeSessionsForTask("proj-1", {
      id: "task-1",
      links: { agentIds: ["agent-old"] },
    } as unknown as KanbanTask);

    expect(host.archivedSnapshots).toEqual(["agent-old"]);
  });

  test("leaves an already archived record alone", async () => {
    const host = buildAgentHost([], [{ id: "agent-old", archivedAt: "2026-07-01T00:00:00.000Z" }]);
    const closer = new TaskSessionCloser({
      agentManager: asAgentHost(host.manager),
      agentStorage: asStorageHost(host.storage),
      logger,
    });

    await closer.closeSessionsForTask("proj-1", {
      id: "task-1",
      links: { agentIds: ["agent-old"] },
    } as unknown as KanbanTask);

    expect(host.archivedSnapshots).toEqual([]);
  });
});

describe("archiving a card closes its session", () => {
  let dir: string;
  let service: TaskBoardService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-session-closer-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedTask(): Promise<KanbanTask> {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    return await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      links: { ...current.links, taskAgentId: "agent-1" },
    }));
  }

  test("fires when the card lands in the terminal archived column", async () => {
    const seen: string[] = [];
    service.setOnTaskArchived((_projectId, task) => {
      seen.push(task.id);
    });
    const task = await seedTask();
    await service.transitionTask("proj-1", task.id, "done");
    await service.transitionTask("proj-1", task.id, "deployed");
    await service.transitionTask("proj-1", task.id, "archived");

    expect(seen).toEqual([task.id]);
  });

  test("fires when the user hides a finished card by hand — once only", async () => {
    const seen: string[] = [];
    service.setOnTaskArchived((_projectId, task) => {
      seen.push(task.id);
    });
    const task = await seedTask();
    await service.transitionTask("proj-1", task.id, "done");
    await service.archiveTask("proj-1", task.id, true);
    // Second call is a no-op: the card is already hidden.
    await service.archiveTask("proj-1", task.id, true);

    expect(seen).toEqual([task.id]);
  });

  test("stays quiet while a card is merely finished", async () => {
    const seen: string[] = [];
    service.setOnTaskArchived((_projectId, task) => {
      seen.push(task.id);
    });
    const task = await seedTask();
    await service.transitionTask("proj-1", task.id, "done");

    expect(seen).toEqual([]);
  });

  test("the sweep closes sessions left behind by cards archived earlier", async () => {
    const host = buildAgentHost([{ id: "agent-1", lifecycle: "idle" }], []);
    const closer = new TaskSessionCloser({
      agentManager: asAgentHost(host.manager),
      agentStorage: asStorageHost(host.storage),
      logger,
    });
    const task = await seedTask();
    await service.transitionTask("proj-1", task.id, "done");
    await service.transitionTask("proj-1", task.id, "deployed");
    await service.transitionTask("proj-1", task.id, "archived");

    await closer.sweepArchivedTasks("proj-1", await service.getBoard("proj-1"));

    expect(host.archived).toEqual(["agent-1"]);
  });
});
