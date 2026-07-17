import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ActivityLogEntry } from "@getpaseo/protocol/activity/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentManager,
  AgentManagerEvent,
  AgentSubscriber,
  ManagedAgent,
} from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { ActivityLogService } from "./service.js";

interface FakeAgentInput {
  id: string;
  cwd?: string;
  workspaceId?: string | null;
  internal?: boolean;
  delegated?: boolean;
  lifecycle?: ManagedAgent["lifecycle"];
}

function fakeAgent(input: FakeAgentInput): ManagedAgent {
  return {
    id: input.id,
    provider: "claude",
    cwd: input.cwd ?? "/tmp/demo-project",
    workspaceId: input.workspaceId ?? undefined,
    internal: input.internal ?? false,
    lifecycle: input.lifecycle ?? "idle",
    labels: input.delegated ? { [PARENT_AGENT_ID_LABEL]: "parent-1" } : {},
    attention: { requiresAttention: false },
  } as unknown as ManagedAgent;
}

class FakeAgentManager {
  private subscriber: AgentSubscriber | null = null;

  subscribe(callback: AgentSubscriber): () => void {
    this.subscriber = callback;
    return () => {
      this.subscriber = null;
    };
  }

  emit(event: AgentManagerEvent): void {
    this.subscriber?.(event);
  }
}

describe("ActivityLogService", () => {
  let dir: string;
  let agentManager: FakeAgentManager;
  let records: Map<string, StoredAgentRecord>;
  let workspaces: Map<string, { workspaceId: string; projectId: string }>;
  let projects: Map<string, { projectId: string; displayName: string; customName?: string | null }>;
  let service: ActivityLogService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "activity-service-"));
    agentManager = new FakeAgentManager();
    records = new Map();
    workspaces = new Map();
    projects = new Map();

    const agentStorage = {
      get: async (agentId: string) => records.get(agentId) ?? null,
    } as unknown as AgentStorage;
    const workspaceRegistry = {
      get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
    } as unknown as WorkspaceRegistry;
    const projectRegistry = {
      get: async (projectId: string) => projects.get(projectId) ?? null,
    } as unknown as ProjectRegistry;

    service = new ActivityLogService({
      agentManager: agentManager as unknown as AgentManager,
      agentStorage,
      workspaceRegistry,
      projectRegistry,
      paseoHome: dir,
      logger: createTestLogger(),
    });
    service.start();
  });

  afterEach(async () => {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function nextEntry(): Promise<ActivityLogEntry> {
    return new Promise((resolve) => {
      const unsubscribe = service.subscribe((entry) => {
        unsubscribe();
        resolve(entry);
      });
    });
  }

  async function flush(): Promise<void> {
    // Let the async event handler settle (storage read + upsert + broadcast).
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }

  test("records an entry titled by the fresh synthesis after a finished turn", async () => {
    records.set("a1", {
      id: "a1",
      provider: "claude",
      cwd: "/tmp/demo-project",
      workspaceId: "w1",
      title: "old title",
      synthesis: { summary: "Refactored the parser", updatedAt: "2026-07-17T10:00:00.000Z" },
    } as unknown as StoredAgentRecord);
    workspaces.set("w1", { workspaceId: "w1", projectId: "p1" });
    projects.set("p1", { projectId: "p1", displayName: "Demo Project" });

    const entryPromise = nextEntry();
    // Turn starts...
    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "a1", workspaceId: "w1", lifecycle: "running" }),
    });
    await flush();
    // ...then finishes with a fresh synthesis on the record.
    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "a1", workspaceId: "w1", lifecycle: "idle" }),
    });

    const entry = await entryPromise;
    expect(entry.agentId).toBe("a1");
    expect(entry.title).toBe("Refactored the parser");
    expect(entry.projectName).toBe("Demo Project");
    expect(await service.list()).toHaveLength(1);
  });

  test("ignores internal agents", async () => {
    records.set("i1", {
      id: "i1",
      provider: "claude",
      cwd: "/tmp/demo-project",
      synthesis: { summary: "internal work", updatedAt: "2026-07-17T10:00:00.000Z" },
    } as unknown as StoredAgentRecord);

    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "i1", internal: true, lifecycle: "running" }),
    });
    await flush();
    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "i1", internal: true, lifecycle: "idle" }),
    });
    await flush();

    expect(await service.list()).toHaveLength(0);
  });

  test("ignores delegated (subagent) agents", async () => {
    records.set("d1", {
      id: "d1",
      provider: "claude",
      cwd: "/tmp/demo-project",
      synthesis: { summary: "subagent work", updatedAt: "2026-07-17T10:00:00.000Z" },
    } as unknown as StoredAgentRecord);

    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "d1", delegated: true, lifecycle: "running" }),
    });
    await flush();
    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "d1", delegated: true, lifecycle: "idle" }),
    });
    await flush();

    expect(await service.list()).toHaveLength(0);
  });

  test("falls back to the cwd basename when no synthesis or title exists", async () => {
    records.set("a2", {
      id: "a2",
      provider: "claude",
      cwd: "/tmp/demo-project",
    } as unknown as StoredAgentRecord);

    const entryPromise = nextEntry();
    agentManager.emit({
      type: "agent_state",
      agent: fakeAgent({ id: "a2", lifecycle: "running" }),
    });
    await flush();
    agentManager.emit({ type: "agent_state", agent: fakeAgent({ id: "a2", lifecycle: "idle" }) });

    const entry = await entryPromise;
    expect(entry.title).toBe("demo-project");
    expect(entry.projectName).toBe("demo-project");
  });
});
