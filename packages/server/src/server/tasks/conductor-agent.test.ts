import { describe, expect, it } from "vitest";
import type pino from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import type {
  BoundCreateAgentCommand,
  CreateAgentCommandInput,
  CreateAgentCommandResult,
} from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { CONDUCTOR_DISALLOWED_TOOLS, ConductorAgentService } from "./conductor-agent.js";

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
    // Paseo tools that execute code or steer other agents/terminals are blocked.
    for (const tool of [
      "mcp__paseo__create_agent",
      "mcp__paseo__send_agent_prompt",
      "mcp__paseo__create_terminal",
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
});
