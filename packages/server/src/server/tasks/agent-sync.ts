import type pino from "pino";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { TASK_AGENT_LABEL } from "./agent-launch.js";
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
 * Bridges live agent activity into the kanban boards: todo timeline items from
 * agents that belong to a project become (or link to) task cards in that
 * project's auto "Agent" folder, and their {@link KanbanTask.progress} flag
 * follows what the agent reports.
 *
 * THIS SERVICE NEVER MOVES A CARD BETWEEN COLUMNS. It used to drag cards into
 * "En cours" on the first sign of agent activity, which is exactly what made
 * fresh cards jump columns on their own. Columns belong to the user's hand, to
 * the scheduler's launch, and to the final-check bar — nothing else. All this
 * service may do is create a card, link an agent to it, and update its progress
 * badge.
 *
 * A card's own agent is excluded outright (see {@link isCardOwnedAgent}): this
 * service only reacts to agents that adopt a card through their todo list.
 * Internal agents never reach it either — the AgentManager global subscription
 * already filters them out.
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

  /**
   * A card's OWN agent is off-limits for this service.
   *
   * Since every card gets an agent the moment it is created, that agent runs
   * turns long before the card is executable: the title tidy-up, the analysis,
   * a question the user asks from the card's chat. Letting those turns drive the
   * board would drag brand-new "À faire" cards straight into "En cours" and mint
   * parasite cards in the "Agent" folder out of the card agent's own todo list.
   * Column moves for a card agent belong to the scheduler, the validator, or the
   * user — never to raw agent activity.
   */
  private isCardOwnedAgent(agentId: string): boolean {
    const agent = this.agentManager.getAgent(agentId);
    return agent?.labels?.[TASK_AGENT_LABEL] !== undefined;
  }

  private async handleEvent(event: AgentManagerEvent): Promise<void> {
    // Agent lifecycle events are deliberately ignored: an agent waking up is not
    // a reason to move a card. Only what the agent *says* (its todo list) is
    // mirrored onto the board, and even that never changes a column.
    if (event.type !== "agent_stream") {
      return;
    }
    if (this.isCardOwnedAgent(event.agentId)) {
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
      // Progress badge only — the card does NOT change column, whatever the
      // agent reports. A checked-off todo means "believed finished", and that is
      // shown on the card where it already sits.
      if (task.column !== "done" && task.column !== "deployed") {
        const progress = item.completed ? "ready_for_review" : "executing";
        if (task.progress !== progress) {
          await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
            ...current,
            progress,
          }));
        }
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
      // Same rule: a completed turn flags the card as believed-finished, and
      // leaves it exactly where the user put it.
      if (completed === true && task.column !== "done" && task.column !== "deployed") {
        if (task.progress !== "ready_for_review") {
          await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
            ...current,
            progress: "ready_for_review" as const,
          }));
        }
      }
    }
  }
}
