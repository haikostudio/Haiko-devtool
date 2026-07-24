import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import realPino from "pino";
import { describe, expect, it } from "vitest";
import type pino from "pino";
import {
  CONDUCTOR_PROJECT_ID_LABEL,
  CONDUCTOR_PROVIDER_LABEL,
  CONDUCTOR_ROLE_LABEL,
  CONDUCTOR_ROLE_VALUE,
} from "@getpaseo/protocol/agent-labels";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type {
  BoundCreateAgentCommand,
  CreateAgentCommandInput,
  CreateAgentCommandResult,
} from "../agent/create-agent/create.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import {
  CONDUCTOR_ALLOWED_PASEO_TOOLS,
  CONDUCTOR_DISALLOWED_TOOLS,
  ConductorAgentService,
} from "./conductor-agent.js";

/** Enumerate every tool the real paseo MCP catalog registers. */
async function listAllPaseoToolNames(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-catalog-"));
  try {
    const logger = realPino({ level: "silent" });
    const catalog = createPaseoToolCatalog({
      agentManager: { listAgents: () => [] } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      taskBoardService: new TaskBoardService({ store: new TaskBoardStore(dir), logger }),
      projectRegistry: { list: async () => [], get: async () => null } as never,
      callerAgentId: "agent-1",
      logger,
    });
    return [...catalog.tools.keys()];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeService(onCreate: (input: CreateAgentCommandInput) => void): ConductorAgentService {
  const createAgent: BoundCreateAgentCommand = async (input) => {
    onCreate(input);
    return {
      snapshot: { id: "conductor-agent", workspaceId: "ws-1" },
      liveSnapshot: { id: "conductor-agent", workspaceId: "ws-1" },
      background: true,
      initialPromptStarted: false,
      initialPromptError: null,
    } as unknown as CreateAgentCommandResult;
  };

  const agentStorage = {
    // No existing conductor → force a fresh create.
    list: async () => [],
  } as unknown as AgentStorage;

  const projectRegistry = {
    get: async () => ({ rootPath: "/tmp/project" }),
  } as unknown as ProjectRegistry;

  const logger = {
    info: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as pino.Logger;

  return new ConductorAgentService({ createAgent, agentStorage, projectRegistry, logger });
}

describe("ConductorAgentService", () => {
  it("hard-blocks every code-acting tool so the conductor can never execute code", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1");

    expect(captured).not.toBeNull();
    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    const disallowed = input.config?.extra?.claude?.disallowedTools ?? [];

    // Editing + shell + subagent spawning must all be blocked.
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "Task"]) {
      expect(disallowed).toContain(tool);
    }
    // Paseo tools that execute code or steer other agents/terminals are blocked,
    // including killing/steering other agents and approving their permissions.
    for (const tool of [
      "mcp__paseo__create_agent",
      "mcp__paseo__send_agent_prompt",
      "mcp__paseo__create_terminal",
      "mcp__paseo__cancel_agent",
      "mcp__paseo__kill_agent",
      "mcp__paseo__update_agent",
      "mcp__paseo__set_agent_mode",
      "mcp__paseo__respond_to_permission",
      "mcp__paseo__create_schedule",
      "mcp__paseo__create_worktree",
    ]) {
      expect(disallowed).toContain(tool);
    }
    // The board tools themselves are NOT blocked — that is the conductor's job.
    for (const tool of ["mcp__paseo__create_task", "mcp__paseo__move_task"]) {
      expect(disallowed).not.toContain(tool);
    }
    expect(disallowed).toEqual([...CONDUCTOR_DISALLOWED_TOOLS]);
  });

  it("instructs the conductor to turn action requests into tasks, never to code", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    const systemPrompt = input.config?.systemPrompt ?? "";
    expect(systemPrompt).toContain("TU NE TOUCHES JAMAIS AU CODE");
    expect(systemPrompt).toContain("UNE TÂCHE, JAMAIS UNE EXÉCUTION");
  });

  it("can create a Codex conductor locked to read-only execution", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1", "codex/gpt-5.4");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("codex/gpt-5.4");
    expect(input.config?.approvalPolicy).toBe("on-request");
    expect(input.config?.sandboxMode).toBe("read-only");
    expect(input.config?.networkAccess).toBe(false);
    expect(input.labels?.[CONDUCTOR_PROVIDER_LABEL]).toBe("codex/gpt-5.4");
    expect(input.config?.systemPrompt ?? "").toContain("TU NE TOUCHES JAMAIS AU CODE");
  });

  it("keeps Claude and Codex conductors separate for the same project", async () => {
    let created = false;
    const existingClaude = {
      id: "existing-claude-conductor",
      provider: "claude/sonnet",
      cwd: "/tmp/project",
      workspaceId: "ws-claude",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
        [CONDUCTOR_PROVIDER_LABEL]: "claude/sonnet",
      },
      lastStatus: "closed",
      config: {},
    } as unknown as StoredAgentRecord;
    const createAgent: BoundCreateAgentCommand = async (input) => {
      created = true;
      expect(input.provider).toBe("codex/gpt-5.4");
      return {
        snapshot: { id: "new-codex-conductor", workspaceId: "ws-codex" },
        liveSnapshot: { id: "new-codex-conductor", workspaceId: "ws-codex" },
        background: true,
        initialPromptStarted: false,
        initialPromptError: null,
      } as unknown as CreateAgentCommandResult;
    };
    const service = new ConductorAgentService({
      createAgent,
      agentStorage: { list: async () => [existingClaude] } as unknown as AgentStorage,
      projectRegistry: {
        get: async () => ({ rootPath: "/tmp/project" }),
      } as unknown as ProjectRegistry,
      logger: { info: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger,
    });

    const result = await service.ensureConductorAgent("project-1", "codex");

    expect(created).toBe(true);
    expect(result.agentId).toBe("new-codex-conductor");
  });

  it("allows ONLY board tools — every other paseo tool is hard-blocked (allowlist completeness)", async () => {
    const allNames = await listAllPaseoToolNames();
    expect(allNames.length).toBeGreaterThan(0);

    const blocked = new Set(CONDUCTOR_DISALLOWED_TOOLS);
    const allowed = new Set(CONDUCTOR_ALLOWED_PASEO_TOOLS);

    for (const name of allNames) {
      const qualified = `mcp__paseo__${name}`;
      if (allowed.has(name)) {
        // Board tool: the conductor keeps it.
        expect(blocked.has(qualified)).toBe(false);
      } else {
        // Anything that is not board management must be impossible to call.
        // If this fails, a NEW paseo tool was added — classify it as allowed
        // (board management) or block it in CONDUCTOR_DISALLOWED_TOOLS.
        expect(blocked.has(qualified)).toBe(true);
      }
    }

    // Every allowed board tool actually exists in the catalog (guards typos).
    for (const name of CONDUCTOR_ALLOWED_PASEO_TOOLS) {
      expect(allNames).toContain(name);
    }
  });

  it("re-locks an existing conductor whose stored config predates the lock", async () => {
    let created = false;
    let upserted: StoredAgentRecord | null = null;

    const staleConductor = {
      id: "existing-conductor",
      provider: "claude/sonnet",
      cwd: "/tmp/project",
      workspaceId: "ws-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
      },
      lastStatus: "closed",
      // Old config: no disallowedTools, no lock prompt → still able to code.
      config: { systemPrompt: "Ancien prompt sans verrou." },
    } as unknown as StoredAgentRecord;

    const createAgent: BoundCreateAgentCommand = async () => {
      created = true;
      return {
        snapshot: { id: "should-not-happen", workspaceId: "ws-1" },
        liveSnapshot: { id: "should-not-happen", workspaceId: "ws-1" },
        background: true,
        initialPromptStarted: false,
        initialPromptError: null,
      } as unknown as CreateAgentCommandResult;
    };
    const agentStorage = {
      list: async () => [staleConductor],
      upsert: async (record: StoredAgentRecord) => {
        upserted = record;
      },
    } as unknown as AgentStorage;
    const projectRegistry = {
      get: async () => ({ rootPath: "/tmp/project" }),
    } as unknown as ProjectRegistry;
    const logger = {
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as pino.Logger;

    const service = new ConductorAgentService({
      createAgent,
      agentStorage,
      projectRegistry,
      logger,
    });
    const result = await service.ensureConductorAgent("project-1");

    // Reuses the existing conductor — never spins up a second one.
    expect(created).toBe(false);
    expect(result.agentId).toBe("existing-conductor");

    // Its stored config is rewritten with the full hard lock + lock prompt.
    expect(upserted).not.toBeNull();
    const rewritten = upserted as unknown as StoredAgentRecord;
    expect(rewritten.config?.extra?.claude?.disallowedTools).toEqual([
      ...CONDUCTOR_DISALLOWED_TOOLS,
    ]);
    expect(rewritten.config?.systemPrompt ?? "").toContain("TU NE TOUCHES JAMAIS AU CODE");
    // Untouched fields survive the rewrite.
    expect(rewritten.id).toBe("existing-conductor");
    expect(rewritten.labels[CONDUCTOR_ROLE_LABEL]).toBe(CONDUCTOR_ROLE_VALUE);
  });

  it("leaves an already-locked conductor untouched (idempotent, no storage churn)", async () => {
    // First, capture the exact config a freshly created conductor gets.
    let createInput: CreateAgentCommandInput | null = null;
    const seedService = makeService((input) => {
      createInput = input;
    });
    await seedService.ensureConductorAgent("project-1");
    const lockedConfig = (
      createInput as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>
    ).config;

    // Now present that same config as an already-persisted conductor.
    let upsertCount = 0;
    let created = false;
    const lockedConductor = {
      id: "locked-conductor",
      provider: "claude/sonnet",
      cwd: "/tmp/project",
      workspaceId: "ws-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
      },
      lastStatus: "closed",
      config: lockedConfig,
    } as unknown as StoredAgentRecord;

    const createAgent: BoundCreateAgentCommand = async () => {
      created = true;
      return {
        snapshot: { id: "nope", workspaceId: "ws-1" },
        liveSnapshot: { id: "nope", workspaceId: "ws-1" },
        background: true,
        initialPromptStarted: false,
        initialPromptError: null,
      } as unknown as CreateAgentCommandResult;
    };
    const agentStorage = {
      list: async () => [lockedConductor],
      upsert: async () => {
        upsertCount += 1;
      },
    } as unknown as AgentStorage;
    const projectRegistry = {
      get: async () => ({ rootPath: "/tmp/project" }),
    } as unknown as ProjectRegistry;
    const logger = {
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as pino.Logger;

    const service = new ConductorAgentService({
      createAgent,
      agentStorage,
      projectRegistry,
      logger,
    });
    await service.ensureConductorAgent("project-1");

    expect(created).toBe(false);
    expect(upsertCount).toBe(0);
  });
});
