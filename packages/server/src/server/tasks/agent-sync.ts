import type pino from "pino";
import {
  agentAwaitsUserInput,
  type AgentManager,
  type AgentManagerEvent,
  type ManagedAgent,
} from "../agent/agent-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { normalizeTaskTitle, type TaskBoardService } from "./service.js";

export const AGENT_SYNC_FOLDER_NAME = "Agent";
const MAX_SYNCED_TASKS_PER_AGENT = 30;
const MIN_TRACKABLE_TITLE_LENGTH = 8;

// Generic one-word-ish todo items that would only produce junk cards.
const TITLE_STOPLIST = new Set([
  "done",
  "fix",
  "fixes",
  "tests",
  "test",
  "cleanup",
  "clean up",
  "refactor",
  "review",
  "todo",
  "wip",
]);

export interface TrackableItem {
  title: string;
  completed: boolean;
}

export function extractTrackableItems(
  items: { text: string; completed: boolean }[],
): TrackableItem[] {
  const result: TrackableItem[] = [];
  for (const item of items) {
    const title = item.text.trim();
    const normalized = normalizeTaskTitle(title);
    if (normalized.length < MIN_TRACKABLE_TITLE_LENGTH) {
      continue;
    }
    if (TITLE_STOPLIST.has(normalized)) {
      continue;
    }
    result.push({ title, completed: item.completed });
  }
  return result;
}

interface AgentTaskSyncServiceOptions {
  agentManager: AgentManager;
  workspaceRegistry: WorkspaceRegistry;
  taskBoardService: TaskBoardService;
  logger: pino.Logger;
}

/**
 * Bridges live agent activity into the kanban boards:
 * - todo timeline items from agents that belong to a project become (or link
 *   to) task cards in that project's auto "Agent" folder;
 * - a linked agent starting a turn drags its tasks to "in_progress";
 * - a completed turn with all matched todo items done drags them to "done".
 *
 * Tasks the user moved by hand (manualOverrideAt set) are left alone, and
 * scheduler-owned tasks (schedule.state === "running") are transitioned by
 * the scheduler, not here. Internal agents never reach this service: the
 * AgentManager global subscription already filters them out.
 */
export class AgentTaskSyncService {
  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly taskBoardService: TaskBoardService;
  private readonly logger: pino.Logger;
  private unsubscribe: (() => void) | null = null;
  // agentId -> projectId (null = resolved as "no project", skip quickly)
  private readonly agentProjects = new Map<string, string | null>();
  // agentId -> normalizedTitle -> completed (last synced todo snapshot)
  private readonly agentTodoState = new Map<string, Map<string, boolean>>();
  private readonly syncedTaskCounts = new Map<string, number>();
  private readonly agentLifecycles = new Map<string, ManagedAgent["lifecycle"]>();

  constructor(options: AgentTaskSyncServiceOptions) {
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.taskBoardService = options.taskBoardService;
    this.logger = options.logger.child({ module: "agent-task-sync" });
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.agentManager.subscribe((event) => {
      void this.handleEvent(event).catch((error) => {
        this.logger.warn({ err: error }, "Agent task sync event failed");
      });
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private async handleEvent(event: AgentManagerEvent): Promise<void> {
    if (event.type === "agent_state") {
      await this.handleAgentState(event.agent);
      return;
    }
    if (event.type !== "agent_stream") {
      return;
    }
    if (event.event.type === "timeline" && event.event.item.type === "todo") {
      await this.handleTodoItems(event.agentId, event.event.item.items);
      return;
    }
    if (event.event.type === "turn_completed") {
      await this.handleTurnCompleted(event.agentId);
    }
  }

  private async resolveProjectId(agentId: string): Promise<string | null> {
    if (this.agentProjects.has(agentId)) {
      return this.agentProjects.get(agentId) ?? null;
    }
    const agent = this.agentManager.getAgent(agentId);
    let projectId: string | null = null;
    if (agent && !agent.internal && agent.workspaceId) {
      const workspace = await this.workspaceRegistry.get(agent.workspaceId);
      projectId = workspace?.projectId ?? null;
    }
    this.agentProjects.set(agentId, projectId);
    return projectId;
  }

  private async handleTodoItems(
    agentId: string,
    items: { text: string; completed: boolean }[],
  ): Promise<void> {
    const projectId = await this.resolveProjectId(agentId);
    if (!projectId) {
      return;
    }
    const trackable = extractTrackableItems(items);
    if (trackable.length === 0) {
      return;
    }

    let todoState = this.agentTodoState.get(agentId);
    if (!todoState) {
      todoState = new Map();
      this.agentTodoState.set(agentId, todoState);
    }

    let folderId: string | null = null;
    for (const item of trackable) {
      const normalized = normalizeTaskTitle(item.title);
      const previous = todoState.get(normalized);
      todoState.set(normalized, item.completed);
      if (previous === item.completed) {
        continue;
      }

      const count = this.syncedTaskCounts.get(agentId) ?? 0;
      if (previous === undefined && count >= MAX_SYNCED_TASKS_PER_AGENT) {
        continue;
      }

      if (!folderId) {
        folderId = await this.taskBoardService.ensureFolder(projectId, AGENT_SYNC_FOLDER_NAME);
      }
      const { task, created } = await this.taskBoardService.upsertSyncedTask(projectId, {
        folderId,
        title: item.title,
        agentId,
      });
      if (created) {
        this.syncedTaskCounts.set(agentId, count + 1);
      }
      if (
        task.manualOverrideAt ||
        task.schedule?.state === "running" ||
        task.approval?.state === "pending"
      ) {
        continue;
      }
      const targetColumn = this.syncTargetColumn(agentId, item.completed);
      // "done" and "deployed" are terminal: agent-sync never drags a finished or
      // shipped task backwards.
      if (task.column !== targetColumn && task.column !== "done" && task.column !== "deployed") {
        await this.taskBoardService.transitionTask(projectId, task.id, targetColumn);
      }
    }
  }

  private async handleTurnCompleted(agentId: string): Promise<void> {
    const projectId = await this.resolveProjectId(agentId);
    if (!projectId) {
      return;
    }
    const todoState = this.agentTodoState.get(agentId);
    if (!todoState || todoState.size === 0) {
      return;
    }
    const board = await this.taskBoardService.getBoard(projectId);
    for (const task of board.tasks) {
      if (!task.links.agentIds.includes(agentId)) {
        continue;
      }
      if (
        task.manualOverrideAt ||
        task.schedule?.state === "running" ||
        task.approval?.state === "pending"
      ) {
        continue;
      }
      const completed = todoState.get(task.normalizedTitle);
      if (
        completed === true &&
        !this.agentAwaitsUser(agentId) &&
        task.column !== "done" &&
        task.column !== "deployed"
      ) {
        await this.taskBoardService.transitionTask(projectId, task.id, "done");
      }
    }
  }

  private async handleAgentState(agent: ManagedAgent): Promise<void> {
    const previous = this.agentLifecycles.get(agent.id);
    this.agentLifecycles.set(agent.id, agent.lifecycle);
    if (previous === agent.lifecycle || agent.lifecycle !== "running") {
      return;
    }
    const projectId = await this.resolveProjectId(agent.id);
    if (!projectId) {
      return;
    }
    const board = await this.taskBoardService.getBoard(projectId);
    for (const task of board.tasks) {
      if (!task.links.agentIds.includes(agent.id)) {
        continue;
      }
      if (
        task.manualOverrideAt ||
        task.schedule?.state === "running" ||
        task.approval?.state === "pending"
      ) {
        continue;
      }
      if (task.column === "backlog" || task.column === "validated" || task.column === "scheduled") {
        await this.taskBoardService.transitionTask(projectId, task.id, "in_progress");
      } else if (task.column === "done") {
        // A finished card whose agent came back to life (e.g. the user relaunched
        // a prompt on it). "done" means nothing is running — so pull it back to
        // "in_progress" to signal work resumed. Shipped ("deployed") stays put.
        await this.taskBoardService.reactivateTask(projectId, task.id);
      }
    }
  }

  /**
   * Whether the agent behind a card is currently blocked on the user. Delegates
   * to the shared AgentManager helper; a missing/closed agent counts as "not
   * waiting" so it never wedges a card out of "done".
   */
  private agentAwaitsUser(agentId: string): boolean {
    const agent = this.agentManager.getAgent(agentId);
    return agent ? agentAwaitsUserInput(agent) : false;
  }

  /**
   * Column a synced todo item should drag its card to. A completed item lands in
   * "done" — UNLESS its agent is still waiting on the user (a pending permission
   * / question), in which case the work isn't finished and the card stays
   * "in_progress" wearing its attention state.
   */
  private syncTargetColumn(agentId: string, completed: boolean): "done" | "in_progress" {
    return completed && !this.agentAwaitsUser(agentId) ? "done" : "in_progress";
  }
}
