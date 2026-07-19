import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../server/agent/agent-manager.js";
import type { AgentStorage } from "../../server/agent/agent-storage.js";
import type { AgentTimelineItem } from "../../server/agent/agent-sdk-types.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../../server/workspace-registry.js";
import { createBrainCaptureHook } from "./capture.js";
import type { BrainMemoryClient } from "./client.js";
import type { BrainCurator } from "./curator.js";

const logger = pino({ level: "silent" });

function shellCommit(message: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "c1",
    name: "Bash",
    status: "completed",
    error: null,
    detail: { type: "shell", command: `git commit -m "${message}"` },
  } as AgentTimelineItem;
}

function makeManager(timeline: AgentTimelineItem[], lastMessage: string) {
  let subscriber: ((event: unknown) => void) | null = null;
  const manager = {
    subscribe(callback: (event: unknown) => void) {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    },
    getTimeline: () => timeline,
    getLastAssistantMessage: async () => lastMessage,
  } as unknown as Pick<AgentManager, "subscribe" | "getTimeline" | "getLastAssistantMessage">;
  return {
    manager,
    emitCompleted: () => subscriber?.({ type: "agent_stream", event: { type: "turn_completed" } }),
  };
}

const scopeDeps = {
  agentStorage: {
    get: async () => ({ cwd: "/root/paseo", workspaceId: undefined }),
  } as unknown as Pick<AgentStorage, "get">,
  workspaceRegistry: { get: async () => null } as unknown as Pick<WorkspaceRegistry, "get">,
  projectRegistry: { get: async () => null } as unknown as Pick<ProjectRegistry, "get">,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createBrainCaptureHook", () => {
  it("distills the completed turn with its durable actions", async () => {
    const timeline: AgentTimelineItem[] = [];
    const { manager, emitCompleted } = makeManager(timeline, "voilà, c'est en ligne");
    const distillExchange = vi.fn(async () => {});
    const hook = createBrainCaptureHook({
      brain: {} as BrainMemoryClient,
      curator: { distillExchange } as unknown as BrainCurator,
      agentManager: manager,
      logger,
      ...scopeDeps,
    });

    hook({ agentId: "agent-1", text: "livre la feature" });
    // The turn runs: a commit lands after the snapshot.
    timeline.push(shellCommit("feat: la feature"));
    emitCompleted();
    await flush();

    expect(distillExchange).toHaveBeenCalledTimes(1);
    expect(distillExchange.mock.calls[0]?.[0]).toMatchObject({
      userText: "livre la feature",
      projet: "paseo",
      actions: "- commit : « feat: la feature »",
    });
  });

  it("does nothing without a brain client or on empty text", async () => {
    const { manager } = makeManager([], "");
    const distillExchange = vi.fn(async () => {});
    const hook = createBrainCaptureHook({
      brain: null,
      curator: { distillExchange } as unknown as BrainCurator,
      agentManager: manager,
      logger,
      ...scopeDeps,
    });
    hook({ agentId: "agent-1", text: "" });
    await flush();
    expect(distillExchange).not.toHaveBeenCalled();
  });
});
