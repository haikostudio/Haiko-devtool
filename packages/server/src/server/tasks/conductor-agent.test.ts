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

// "/root/paseo" is REPO_ROOT in paseo-deploy.ts, so isPaseoDeployRoot() treats a
// project rooted here as Paseo itself → the conductor becomes a full agent.
const PASEO_SELF_ROOT = "/root/paseo";

function makeService(
  onCreate: (input: CreateAgentCommandInput) => void,
  rootPath = "/tmp/project",
): ConductorAgentService {
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
    get: async () => ({ rootPath }),
  } as unknown as ProjectRegistry;

  const logger = {
    info: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as pino.Logger;

  return new ConductorAgentService({ createAgent, agentStorage, projectRegistry, logger });
}

/**
 * A service whose storage already holds `existing`, so `ensureConductorAgent`
 * must reuse (and possibly re-lock) it instead of creating a new conductor.
 * Every rewritten record lands in `upserts`.
 */
function makeReuseService(
  existing: StoredAgentRecord,
  upserts: StoredAgentRecord[],
  rootPath = "/tmp/project",
): ConductorAgentService {
  return new ConductorAgentService({
    createAgent: (async () => {
      throw new Error("must reuse the existing conductor, not create one");
    }) as unknown as BoundCreateAgentCommand,
    agentStorage: {
      list: async () => [existing],
      upsert: async (record: StoredAgentRecord) => {
        upserts.push(record);
      },
    } as unknown as AgentStorage,
    projectRegistry: {
      get: async () => ({ rootPath }),
    } as unknown as ProjectRegistry,
    logger: { info: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger,
  });
}

/**
 * The conductor's system prompt is hard-wrapped for readability, so a sentence
 * of it straddles line breaks. Tests assert on the SENSE of the instruction, not
 * on where it happens to wrap: read it back as one flat, single-spaced string.
 */
async function conductorSystemPromptText(): Promise<string> {
  let captured: CreateAgentCommandInput | null = null;
  const service = makeService((input) => {
    captured = input;
  });
  await service.ensureConductorAgent("project-1");
  const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
  return (input.config?.systemPrompt ?? "").replace(/\s+/g, " ");
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

  it("on the Paseo repo itself, the conductor is a full agent with no tool lock", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    }, PASEO_SELF_ROOT);

    await service.ensureConductorAgent("project-1");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    // No tools are stripped: it can edit code, run commands, steer agents.
    expect(input.config?.extra?.claude?.disallowedTools ?? []).toEqual([]);
    // The prompt tells it to act directly instead of minting a card.
    const systemPrompt = (input.config?.systemPrompt ?? "").replace(/\s+/g, " ");
    expect(systemPrompt).toContain("AGENT COMPLET");
    expect(systemPrompt).toContain("Paseo lui-même");
    // And it still respects the deploy discretion: never publish on its own.
    expect(systemPrompt).toContain("ne DÉPLOIES JAMAIS");
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

  it("answers a question in conversation instead of minting a card", async () => {
    const systemPrompt = await conductorSystemPromptText();

    // The old rule — every message becomes a task — is gone, replaced by a triage.
    expect(systemPrompt).not.toContain("Interprète CHAQUE message de l'utilisateur");
    expect(systemPrompt).toContain("TOUT MESSAGE NE DEVIENT PAS UNE CARTE");
    expect(systemPrompt).toContain("QUESTION ou DEMANDE D'INFORMATION");
    expect(systemPrompt).toContain("tu ne crées AUCUNE carte");
    // Worked examples, so the model recognises the shape of a question.
    for (const example of [
      "comment ça marche ?",
      "où en est la tâche X ?",
      "combien de cartes sont en attente ?",
      "pourquoi ce",
    ]) {
      expect(systemPrompt).toContain(example);
    }
    // Reading the board or the code to answer is explicitly allowed.
    expect(systemPrompt).toContain("lire n'est pas agir");
  });

  it("still turns an action request into a card created straight in « À faire »", async () => {
    const systemPrompt = await conductorSystemPromptText();

    expect(systemPrompt).toContain("DEMANDE D'ACTION");
    expect(systemPrompt).toContain("create_task");
    expect(systemPrompt).toContain("proposeRun à false");
    // Worked examples of the action family, including a reported bug.
    for (const example of [
      "corrige le graphe",
      "ajoute un bouton d'export",
      "supprime la section",
      "un bug signalé est une demande de",
    ]) {
      expect(systemPrompt).toContain(example);
    }
  });

  it("offers a card on an ambiguous message instead of creating one", async () => {
    const systemPrompt = await conductorSystemPromptText();

    expect(systemPrompt).toContain("CAS AMBIGU");
    expect(systemPrompt).toContain("Souhaitez-vous que j'en fasse une tâche ?");
    expect(systemPrompt).toContain("si l'utilisateur confirme");
    // The app hangs a one-click confirm button on that sentence, which it can
    // only find if the offer closes the answer on a line of its own.
    expect(systemPrompt).toContain("Écris-la en DERNIER et sur sa propre ligne");
  });

  it("handles board upkeep with a tool call, not with a card about the card", async () => {
    const systemPrompt = await conductorSystemPromptText();

    expect(systemPrompt).toContain("GESTION DU TABLEAU LUI-MÊME");
    expect(systemPrompt).toContain("renomme la carte X");
    expect(systemPrompt).toContain("update_task / move_task / delete_task / list_tasks");
  });

  it("keeps the conductor out of the long report template, and off « Validé »", async () => {
    const systemPrompt = await conductorSystemPromptText();

    // A plain answer must not be dressed up as a work report: the five-section
    // template is injected on every dispatch, so the prompt overrides it here too.
    expect(systemPrompt).toContain("ne s'applique JAMAIS à toi");
    expect(systemPrompt).toContain("sans estimation et sans facturation");
    // The two standing bans survive the triage rewrite.
    expect(systemPrompt).toContain("LA VALIDATION APPARTIENT À L'UTILISATEUR");
    expect(systemPrompt).toContain("jamais passer une carte en « Validé »");
  });

  it("starts a Claude conductor on medium thinking effort, not the catalog's low", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.config?.thinkingOptionId).toBe("medium");
  });

  it("creates a Claude conductor pinned to Sonnet 5, not the catalog default", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("claude/claude-sonnet-5");
    expect(input.config?.model).toBe("claude-sonnet-5");
    expect(input.labels?.[CONDUCTOR_PROVIDER_LABEL]).toBe("claude/claude-sonnet-5");
  });

  it("on Paseo itself, a fresh Claude conductor gets Opus 5 on high effort", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    }, PASEO_SELF_ROOT);

    await service.ensureConductorAgent("project-1", "claude");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.config?.model).toBe("claude-opus-5");
    expect(input.config?.thinkingOptionId).toBe("high");
  });

  it("on Paseo itself, a fresh Codex conductor gets GPT-5.6-Sol on high effort", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    }, PASEO_SELF_ROOT);

    await service.ensureConductorAgent("project-1", "codex");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.config?.model).toBe("gpt-5.6-sol");
    expect(input.config?.thinkingOptionId).toBe("high");
  });

  it('accepts the bare "claude" provider the client sends over the wire', async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1", "claude");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("claude/claude-sonnet-5");
    expect(input.config?.model).toBe("claude-sonnet-5");
  });

  it("still answers to the legacy claude/sonnet provider spec", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1", "claude/sonnet");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("claude/claude-sonnet-5");
    expect(input.config?.model).toBe("claude-sonnet-5");
  });

  it("still answers to the previous claude/claude-opus-4-8 provider spec", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1", "claude/claude-opus-4-8");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("claude/claude-sonnet-5");
  });

  it("moves an existing conductor off the legacy sonnet model", async () => {
    const existing = {
      id: "legacy-claude-conductor",
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
      config: { thinkingOptionId: "high", model: "sonnet" },
    } as unknown as StoredAgentRecord;
    const upserts: StoredAgentRecord[] = [];
    const service = makeReuseService(existing, upserts);

    const result = await service.ensureConductorAgent("project-1");

    expect(result.agentId).toBe("legacy-claude-conductor");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.config?.model).toBe("claude-sonnet-5");
    expect(upserts[0]?.labels?.[CONDUCTOR_PROVIDER_LABEL]).toBe("claude/claude-sonnet-5");
  });

  it("keeps a model the user picked from the composer's model menu", async () => {
    const existing = {
      id: "tuned-model-conductor",
      provider: "claude/claude-opus-4-8",
      cwd: "/tmp/project",
      workspaceId: "ws-claude",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
        [CONDUCTOR_PROVIDER_LABEL]: "claude/claude-opus-4-8",
      },
      lastStatus: "closed",
      // Stale in every other respect, so the re-lock below definitely runs.
      config: { thinkingOptionId: "high", model: "claude-opus-5[1m]" },
    } as unknown as StoredAgentRecord;
    const upserts: StoredAgentRecord[] = [];
    const service = makeReuseService(existing, upserts);

    await service.ensureConductorAgent("project-1");

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.config?.model).toBe("claude-opus-5[1m]");
  });

  it("on Paseo, upgrades an existing Claude conductor stuck on the board-manager pin", async () => {
    // Created before `isSelf` earned the frontier model, so it carries the leaked
    // board-manager sonnet-5 / medium. On Paseo those are never a real pick and must
    // self-heal up to Opus 5 / high instead of staying cheap for the record's life.
    const existing = {
      id: "paseo-claude-conductor",
      provider: "claude/claude-sonnet-5",
      cwd: PASEO_SELF_ROOT,
      workspaceId: "ws-claude",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
        [CONDUCTOR_PROVIDER_LABEL]: "claude/claude-sonnet-5",
      },
      lastStatus: "closed",
      config: { thinkingOptionId: "medium", model: "claude-sonnet-5" },
    } as unknown as StoredAgentRecord;
    const upserts: StoredAgentRecord[] = [];
    const service = makeReuseService(existing, upserts, PASEO_SELF_ROOT);

    await service.ensureConductorAgent("project-1");

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.config?.model).toBe("claude-opus-5");
    expect(upserts[0]?.config?.thinkingOptionId).toBe("high");
  });

  it("on Paseo, upgrades an existing Codex conductor stuck on the board-manager pin", async () => {
    const existing = {
      id: "paseo-codex-conductor",
      provider: "codex/gpt-5.6-luna",
      cwd: PASEO_SELF_ROOT,
      workspaceId: "ws-codex",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
        [CONDUCTOR_PROVIDER_LABEL]: "codex/gpt-5.6-luna",
      },
      lastStatus: "closed",
      config: {
        thinkingOptionId: "medium",
        model: "gpt-5.6-luna",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      },
    } as unknown as StoredAgentRecord;
    const upserts: StoredAgentRecord[] = [];
    const service = makeReuseService(existing, upserts, PASEO_SELF_ROOT);

    await service.ensureConductorAgent("project-1", "codex");

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.config?.model).toBe("gpt-5.6-sol");
    expect(upserts[0]?.config?.thinkingOptionId).toBe("high");
  });

  it("re-locks an existing Claude conductor that has no stored thinking level", async () => {
    const existing = {
      id: "old-claude-conductor",
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
    const upserts: StoredAgentRecord[] = [];
    const service = new ConductorAgentService({
      createAgent: (async () => {
        throw new Error("must reuse the existing conductor, not create one");
      }) as unknown as BoundCreateAgentCommand,
      agentStorage: {
        list: async () => [existing],
        upsert: async (record: StoredAgentRecord) => {
          upserts.push(record);
        },
      } as unknown as AgentStorage,
      projectRegistry: {
        get: async () => ({ rootPath: "/tmp/project" }),
      } as unknown as ProjectRegistry,
      logger: { info: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger,
    });

    const result = await service.ensureConductorAgent("project-1");

    expect(result.agentId).toBe("old-claude-conductor");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.config?.thinkingOptionId).toBe("medium");
  });

  it("keeps a thinking level the user picked explicitly", async () => {
    const existing = {
      id: "tuned-claude-conductor",
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
      // Stale in every other respect, so the re-lock below definitely runs.
      config: { thinkingOptionId: "max" },
    } as unknown as StoredAgentRecord;
    const upserts: StoredAgentRecord[] = [];
    const service = new ConductorAgentService({
      createAgent: (async () => {
        throw new Error("must reuse the existing conductor, not create one");
      }) as unknown as BoundCreateAgentCommand,
      agentStorage: {
        list: async () => [existing],
        upsert: async (record: StoredAgentRecord) => {
          upserts.push(record);
        },
      } as unknown as AgentStorage,
      projectRegistry: {
        get: async () => ({ rootPath: "/tmp/project" }),
      } as unknown as ProjectRegistry,
      logger: { info: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger,
    });

    await service.ensureConductorAgent("project-1");

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.config?.thinkingOptionId).toBe("max");
  });

  it("can create a Codex conductor locked to read-only execution", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1", "codex");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("codex/gpt-5.6-luna");
    expect(input.config?.model).toBe("gpt-5.6-luna");
    expect(input.config?.thinkingOptionId).toBe("medium");
    expect(input.config?.approvalPolicy).toBe("on-request");
    expect(input.config?.sandboxMode).toBe("read-only");
    expect(input.config?.networkAccess).toBe(false);
    expect(input.labels?.[CONDUCTOR_PROVIDER_LABEL]).toBe("codex/gpt-5.6-luna");
    expect(input.config?.systemPrompt ?? "").toContain("TU NE TOUCHES JAMAIS AU CODE");
  });

  it("still answers to the previous codex/gpt-5.4 provider spec", async () => {
    let captured: CreateAgentCommandInput | null = null;
    const service = makeService((input) => {
      captured = input;
    });

    await service.ensureConductorAgent("project-1", "codex/gpt-5.4");

    const input = captured as unknown as Extract<CreateAgentCommandInput, { kind: "mcp" }>;
    expect(input.provider).toBe("codex/gpt-5.6-luna");
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
      expect(input.provider).toBe("codex/gpt-5.6-luna");
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

  it("retires the previous conductor on reset WITHOUT archiving its conversation", async () => {
    const existing = {
      id: "old-conductor",
      provider: "codex/gpt-5.4",
      cwd: "/tmp/project",
      workspaceId: "ws-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: "project-1",
        [CONDUCTOR_PROVIDER_LABEL]: "codex/gpt-5.4",
        "keep.me": "yes",
      },
      lastStatus: "closed",
      config: {},
    } as unknown as StoredAgentRecord;
    const upserts: StoredAgentRecord[] = [];
    const createAgent: BoundCreateAgentCommand = async () =>
      ({
        snapshot: { id: "fresh-conductor", workspaceId: "ws-fresh" },
        liveSnapshot: { id: "fresh-conductor", workspaceId: "ws-fresh" },
        background: true,
        initialPromptStarted: false,
        initialPromptError: null,
      }) as unknown as CreateAgentCommandResult;
    const service = new ConductorAgentService({
      createAgent,
      agentStorage: {
        list: async () => [existing],
        upsert: async (record: StoredAgentRecord) => {
          upserts.push(record);
        },
      } as unknown as AgentStorage,
      projectRegistry: {
        get: async () => ({ rootPath: "/tmp/project" }),
      } as unknown as ProjectRegistry,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as unknown as pino.Logger,
    });

    const result = await service.ensureConductorAgent("project-1", "codex", { reset: true });

    // A brand-new conductor answers the reset.
    expect(result.agentId).toBe("fresh-conductor");
    // The old one is retired by DROPPING ITS ROLE LABELS — never archived, which
    // would archive the provider thread and make that conversation unopenable
    // forever. Unrelated labels are preserved.
    expect(upserts).toHaveLength(1);
    const retired = upserts[0]!;
    expect(retired.id).toBe("old-conductor");
    expect(retired.labels[CONDUCTOR_ROLE_LABEL]).toBeUndefined();
    expect(retired.labels[CONDUCTOR_PROJECT_ID_LABEL]).toBeUndefined();
    expect(retired.labels["keep.me"]).toBe("yes");
    expect(retired.archivedAt ?? null).toBeNull();
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
