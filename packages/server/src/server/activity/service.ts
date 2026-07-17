import { basename, join } from "node:path";
import type { Logger } from "pino";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import type { ActivityLogEntry } from "@getpaseo/protocol/activity/types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  resolveProjectDisplayName,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";
import { ActivityLogStore } from "./store.js";

export type ActivityLogListener = (entry: ActivityLogEntry) => void;

interface ActivityLogServiceOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  paseoHome: string;
  logger: Logger;
}

/**
 * Daemon-managed global activity log. A single subscription to the AgentManager
 * records one line per agent, refreshed each time the agent finishes a turn,
 * titled with the agent's latest synthesis summary. Being wired once at
 * bootstrap (not per session) guarantees exactly one entry per turn regardless
 * of how many clients are connected.
 */
export class ActivityLogService {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly projectRegistry: ProjectRegistry;
  private readonly store: ActivityLogStore;
  private readonly logger: Logger;
  private readonly listeners = new Set<ActivityLogListener>();
  private readonly lifecycles = new Map<string, ManagedAgent["lifecycle"]>();
  private readonly lastSynthesisAt = new Map<string, string>();
  private readonly recorded = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: ActivityLogServiceOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.workspaceRegistry = options.workspaceRegistry;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "activity-log" });
    this.store = new ActivityLogStore(join(options.paseoHome, "activity-log.json"), this.logger);
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.agentManager.subscribe((event) => {
      void this.handleEvent(event).catch((error) => {
        this.logger.warn({ err: error }, "Activity log event failed");
      });
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  list(): Promise<ActivityLogEntry[]> {
    return this.store.list();
  }

  subscribe(listener: ActivityLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async handleEvent(event: AgentManagerEvent): Promise<void> {
    if (event.type !== "agent_state") {
      return;
    }
    const agent = event.agent;
    if (agent.internal || isDelegatedAgent(agent)) {
      return;
    }

    const previous = this.lifecycles.get(agent.id);
    this.lifecycles.set(agent.id, agent.lifecycle);

    const record = await this.agentStorage.get(agent.id);
    const synthesisAt = record?.synthesis?.updatedAt ?? null;
    const synthesisChanged =
      synthesisAt !== null && this.lastSynthesisAt.get(agent.id) !== synthesisAt;
    if (synthesisAt !== null) {
      this.lastSynthesisAt.set(agent.id, synthesisAt);
    }

    // Record when a fresh synthesis lands (the best title), and when a turn
    // finishes for an agent that has no line yet (so a line still appears for
    // providers where synthesis is unavailable).
    const finishedTurn = previous === "running" && agent.lifecycle === "idle";
    const shouldRecord = synthesisChanged || (finishedTurn && !this.recorded.has(agent.id));
    if (!shouldRecord) {
      return;
    }

    const title =
      record?.synthesis?.summary?.trim() ||
      record?.title?.trim() ||
      basename(agent.cwd) ||
      agent.cwd;
    const now = new Date().toISOString();
    const projectName = await this.resolveProjectName(agent);
    const entry = await this.store.upsert({
      id: agent.id,
      agentId: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      workspaceId: agent.workspaceId ?? null,
      projectName,
      title,
      createdAt: now,
      updatedAt: now,
    });
    this.recorded.add(agent.id);
    this.broadcast(entry);
  }

  private async resolveProjectName(agent: ManagedAgent): Promise<string> {
    if (agent.workspaceId) {
      const workspace = await this.workspaceRegistry.get(agent.workspaceId);
      if (workspace) {
        const project = await this.projectRegistry.get(workspace.projectId);
        if (project) {
          return resolveProjectDisplayName(project);
        }
        const workspaceName = workspace.title ?? workspace.displayName;
        if (workspaceName?.trim()) {
          return workspaceName.trim();
        }
      }
    }
    return basename(agent.cwd) || agent.cwd;
  }

  private broadcast(entry: ActivityLogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        this.logger.warn({ err: error, agentId: entry.agentId }, "Activity log listener failed");
      }
    }
  }
}
