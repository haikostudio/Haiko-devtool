import type pino from "pino";
import type {
  KanbanTask,
  TaskApproval,
  TaskBilling,
  TaskBoard,
  TaskColumn,
  TaskFolder,
  TaskImageAttachment,
  TaskRunConfig,
  TaskSchedulePreference,
} from "@getpaseo/protocol/tasks/types";
import { slugifyBranch } from "./agent-launch.js";
import { TaskBoardStore, generateTaskEntityId } from "./store.js";

export type TaskBoardListener = (board: TaskBoard) => void;

// Columns where the scheduler runs analysis + execution. "validated" is the
// consent gate: dropping a task here starts the automated pipeline. "scheduled"
// remains a valid direct-drop entry point (and the queued-for-launch state).
const PIPELINE_COLUMNS = new Set<TaskColumn>(["validated", "scheduled"]);

export class TaskBoardServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskBoardServiceError";
  }
}

function repackFolderOrders(folders: TaskFolder[]): TaskFolder[] {
  return folders.map((entry, index) =>
    entry.order === index ? entry : Object.assign({}, entry, { order: index }),
  );
}

/**
 * A folder IS a git branch: derive a valid branch ref from an explicit branch
 * (each `/`-segment slugified) or, absent that, from the folder name (prefixed
 * `feat/`). Returns undefined when nothing usable can be derived, so callers keep
 * the legacy per-task branch fallback.
 */
function deriveFolderBranch(name: string, branch?: string): string | undefined {
  const raw = branch?.trim() ? branch : name;
  const cleaned = raw
    .split("/")
    .map((segment) => slugifyBranch(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
  if (!cleaned) {
    return undefined;
  }
  // A bare name (no slash) becomes a conventional feature branch.
  return branch?.trim() && branch.includes("/") ? cleaned : `feat/${cleaned}`;
}

/**
 * Dedupe key used by the agent-sync layer: lowercase, whitespace collapsed,
 * leading checkbox/bullet markers and trailing punctuation stripped.
 */
export function normalizeTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*(?:(?:[-*+•]|\[[ xX]\]|\d+[.)])\s*)+/, "")
    .replace(/[.:;!]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface CreateTaskInput {
  folderId: string;
  title: string;
  description?: string;
  tags?: string[];
  column?: TaskColumn;
  origin?: KanbanTask["origin"];
  agentId?: string;
  runConfig?: TaskRunConfig;
  schedulePreference?: TaskSchedulePreference;
  // "pending" gates the scheduler until the user approves (agent proposals).
  approval?: TaskApproval;
  // Pictures attached in the board's "add task" card, handed to the agent.
  images?: TaskImageAttachment[];
}

interface MoveTaskInput {
  taskId: string;
  column: TaskColumn;
  index: number;
  // True for user-initiated drags: stamps manualOverrideAt so agent-sync
  // stops fighting the user over this task's column.
  manual: boolean;
}

interface TaskBoardServiceOptions {
  store: TaskBoardStore;
  logger: pino.Logger;
}

/**
 * CRUD + subscription surface over per-project kanban boards. Every successful
 * mutation pushes the fresh board snapshot to that project's subscribers.
 * Side effects that belong to other subsystems (estimation, scheduling) hang
 * off onTaskScheduled, wired at bootstrap.
 */
export class TaskBoardService {
  private readonly store: TaskBoardStore;
  private readonly logger: pino.Logger;
  private readonly listeners = new Map<string, Set<TaskBoardListener>>();
  private onTaskScheduled: ((projectId: string, taskId: string) => void) | null = null;
  private onTaskProposed: ((projectId: string, task: KanbanTask) => void) | null = null;

  constructor(options: TaskBoardServiceOptions) {
    this.store = options.store;
    this.logger = options.logger;
  }

  setOnTaskScheduled(callback: (projectId: string, taskId: string) => void): void {
    this.onTaskScheduled = callback;
  }

  /** Fired when a task is created awaiting user approval (agent proposals). */
  setOnTaskProposed(callback: (projectId: string, task: KanbanTask) => void): void {
    this.onTaskProposed = callback;
  }

  subscribe(projectId: string, listener: TaskBoardListener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) {
      set = new Set();
      this.listeners.set(projectId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(projectId);
      }
    };
  }

  private broadcast(board: TaskBoard): void {
    const set = this.listeners.get(board.projectId);
    if (!set) {
      return;
    }
    for (const listener of set) {
      try {
        listener(board);
      } catch (error) {
        this.logger.warn({ err: error, projectId: board.projectId }, "Task board listener failed");
      }
    }
  }

  async getBoard(projectId: string): Promise<TaskBoard> {
    return this.store.getBoard(projectId);
  }

  // ---- Folders ----

  async createFolder(
    projectId: string,
    name: string,
    color?: string,
    autopilot?: boolean,
    branch?: string,
  ): Promise<TaskFolder> {
    let created: TaskFolder | null = null;
    const resolvedBranch = deriveFolderBranch(name, branch);
    const board = await this.store.mutate(projectId, (current) => {
      created = {
        id: generateTaskEntityId(),
        name: name.trim(),
        ...(color ? { color } : {}),
        ...(autopilot !== undefined ? { autopilot } : {}),
        ...(resolvedBranch ? { branch: resolvedBranch } : {}),
        order: current.folders.length,
        createdAt: new Date().toISOString(),
      };
      return { ...current, folders: [...current.folders, created] };
    });
    this.broadcast(board);
    if (!created) {
      throw new TaskBoardServiceError("folder_create_failed", "Folder creation produced no folder");
    }
    return created;
  }

  async updateFolder(
    projectId: string,
    folderId: string,
    changes: {
      name?: string;
      color?: string;
      autopilot?: boolean;
      branch?: string;
      order?: number;
    },
  ): Promise<TaskFolder> {
    let updated: TaskFolder | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      const folder = current.folders.find((entry) => entry.id === folderId);
      if (!folder) {
        throw new TaskBoardServiceError("folder_not_found", `Folder not found: ${folderId}`);
      }
      // Editing the branch (or the name when the branch was derived from it)
      // re-derives the ref and drops the shared worktree so the next launch
      // recreates it on the new branch.
      const nextBranch =
        changes.branch !== undefined
          ? deriveFolderBranch(changes.name ?? folder.name, changes.branch)
          : folder.branch;
      const branchChanged = nextBranch !== folder.branch;
      updated = {
        ...folder,
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
        ...(changes.color !== undefined ? { color: changes.color } : {}),
        ...(changes.autopilot !== undefined ? { autopilot: changes.autopilot } : {}),
        ...(changes.branch !== undefined ? { branch: nextBranch } : {}),
        ...(branchChanged ? { workspaceId: null, worktreeCwd: null } : {}),
        ...(changes.order !== undefined ? { order: changes.order } : {}),
      };
      const others = current.folders.filter((entry) => entry.id !== folderId);
      const folders = [...others, updated].sort(
        (a, b) => a.order - b.order || a.id.localeCompare(b.id),
      );
      return { ...current, folders: repackFolderOrders(folders) };
    });
    this.broadcast(board);
    if (!updated) {
      throw new TaskBoardServiceError("folder_not_found", `Folder not found: ${folderId}`);
    }
    return board.folders.find((entry) => entry.id === folderId) ?? updated;
  }

  async deleteFolder(projectId: string, folderId: string): Promise<void> {
    const board = await this.store.mutate(projectId, (current) => {
      if (!current.folders.some((entry) => entry.id === folderId)) {
        throw new TaskBoardServiceError("folder_not_found", `Folder not found: ${folderId}`);
      }
      return {
        ...current,
        folders: repackFolderOrders(current.folders.filter((entry) => entry.id !== folderId)),
        tasks: current.tasks.filter((task) => task.folderId !== folderId),
      };
    });
    this.broadcast(board);
  }

  /**
   * Returns the id of the folder with the given name, creating it (race-safe,
   * store-serialized) if absent. Used by agent-sync for its auto folder.
   */
  async ensureFolder(projectId: string, name: string): Promise<string> {
    let folderId: string | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      const existing = current.folders.find((entry) => entry.name === name);
      if (existing) {
        folderId = existing.id;
        return current;
      }
      const created: TaskFolder = {
        id: generateTaskEntityId(),
        name,
        order: current.folders.length,
        createdAt: new Date().toISOString(),
      };
      folderId = created.id;
      return { ...current, folders: [...current.folders, created] };
    });
    this.broadcast(board);
    if (!folderId) {
      throw new TaskBoardServiceError("folder_create_failed", `Failed to ensure folder: ${name}`);
    }
    return folderId;
  }

  /**
   * Records the shared worktree the scheduler created for a folder's branch, so
   * later tasks in the same folder reuse it instead of branching off again. No-op
   * if the folder no longer exists (it may have been deleted mid-launch).
   */
  async setFolderWorkspace(
    projectId: string,
    folderId: string,
    input: { branch: string; workspaceId: string; worktreeCwd: string },
  ): Promise<void> {
    const board = await this.store.mutate(projectId, (current) => {
      const folder = current.folders.find((entry) => entry.id === folderId);
      if (!folder) {
        return current;
      }
      const updated: TaskFolder = {
        ...folder,
        branch: input.branch,
        workspaceId: input.workspaceId,
        worktreeCwd: input.worktreeCwd,
      };
      return {
        ...current,
        folders: current.folders.map((entry) => (entry.id === folderId ? updated : entry)),
      };
    });
    this.broadcast(board);
  }

  // ---- Tasks ----

  async createTask(projectId: string, input: CreateTaskInput): Promise<KanbanTask> {
    let created: KanbanTask | null = null;
    const column = input.column ?? "backlog";
    const board = await this.store.mutate(projectId, (current) => {
      if (!current.folders.some((entry) => entry.id === input.folderId)) {
        throw new TaskBoardServiceError("folder_not_found", `Folder not found: ${input.folderId}`);
      }
      const now = new Date().toISOString();
      const siblings = current.tasks.filter(
        (task) => task.folderId === input.folderId && task.column === column,
      );
      created = {
        id: generateTaskEntityId(),
        folderId: input.folderId,
        title: input.title.trim(),
        ...(input.description !== undefined ? { description: input.description } : {}),
        tags: input.tags ?? [],
        column,
        order: siblings.length,
        origin: input.origin ?? "manual",
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        normalizedTitle: normalizeTaskTitle(input.title),
        ...(input.runConfig !== undefined ? { runConfig: input.runConfig } : {}),
        ...(input.schedulePreference !== undefined
          ? { schedulePreference: input.schedulePreference }
          : {}),
        ...(input.approval !== undefined ? { approval: input.approval } : {}),
        ...(PIPELINE_COLUMNS.has(column)
          ? { schedule: { state: "pending_estimate" as const, attempts: 0 } }
          : {}),
        links: input.agentId
          ? { agentIds: [input.agentId], primaryAgentId: input.agentId }
          : { agentIds: [] },
        createdAt: now,
        updatedAt: now,
      };
      return { ...current, tasks: [...current.tasks, created] };
    });
    this.broadcast(board);
    if (!created) {
      throw new TaskBoardServiceError("task_create_failed", "Task creation produced no task");
    }
    if (PIPELINE_COLUMNS.has(column)) {
      this.notifyScheduled(projectId, created);
    }
    if (input.approval?.state === "pending" && this.onTaskProposed) {
      try {
        this.onTaskProposed(projectId, created);
      } catch (error) {
        this.logger.warn({ err: error, title: input.title }, "onTaskProposed callback failed");
      }
    }
    return created;
  }

  async updateTask(
    projectId: string,
    taskId: string,
    changes: {
      title?: string;
      description?: string | null;
      tags?: string[];
      runConfig?: TaskRunConfig | null;
      schedulePreference?: TaskSchedulePreference | null;
      billing?: TaskBilling | null;
      executionHold?: boolean | null;
    },
  ): Promise<KanbanTask> {
    const board = await this.mutateTask(projectId, taskId, (task) => {
      const updated = { ...task };
      if (changes.title !== undefined) {
        updated.title = changes.title.trim();
        updated.normalizedTitle = normalizeTaskTitle(changes.title);
      }
      if (changes.description === null) {
        delete updated.description;
      } else if (changes.description !== undefined) {
        updated.description = changes.description;
      }
      if (changes.tags !== undefined) {
        updated.tags = changes.tags;
      }
      if (changes.runConfig === null) {
        delete updated.runConfig;
      } else if (changes.runConfig !== undefined) {
        updated.runConfig = changes.runConfig;
      }
      if (changes.schedulePreference === null) {
        delete updated.schedulePreference;
      } else if (changes.schedulePreference !== undefined) {
        updated.schedulePreference = changes.schedulePreference;
      }
      if (changes.billing === null) {
        delete updated.billing;
      } else if (changes.billing !== undefined) {
        updated.billing = changes.billing;
      }
      if (changes.executionHold === null || changes.executionHold === false) {
        delete updated.executionHold;
      } else if (changes.executionHold === true) {
        updated.executionHold = true;
      }
      return updated;
    });
    return this.requireTask(board, taskId);
  }

  /**
   * User approval of an agent-proposed task. If the task sits in "scheduled"
   * without a schedule yet, arms it so the estimator/scheduler pick it up.
   */
  async approveTask(projectId: string, taskId: string): Promise<KanbanTask> {
    let needsScheduleNotify = false;
    const board = await this.mutateTask(projectId, taskId, (task) => {
      if (task.approval?.state !== "pending") {
        return task;
      }
      const now = new Date().toISOString();
      const updated: KanbanTask = {
        ...task,
        approval: { ...task.approval, state: "approved", approvedAt: now },
      };
      if (PIPELINE_COLUMNS.has(task.column) && !task.schedule) {
        updated.schedule = { state: "pending_estimate", attempts: 0 };
        needsScheduleNotify = true;
      }
      return updated;
    });
    const task = this.requireTask(board, taskId);
    if (needsScheduleNotify) {
      this.notifyScheduled(projectId, task);
    }
    return task;
  }

  /**
   * Partial task patch reserved for internal collaborators (agent-sync,
   * estimator, scheduler). Never stamps manualOverrideAt.
   */
  async patchTask(
    projectId: string,
    taskId: string,
    patch: (task: KanbanTask) => KanbanTask,
  ): Promise<KanbanTask> {
    const board = await this.mutateTask(projectId, taskId, patch);
    return this.requireTask(board, taskId);
  }

  async moveTask(projectId: string, input: MoveTaskInput): Promise<TaskBoard> {
    let scheduledTask: KanbanTask | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      const task = current.tasks.find((entry) => entry.id === input.taskId);
      if (!task) {
        throw new TaskBoardServiceError("task_not_found", `Task not found: ${input.taskId}`);
      }
      const now = new Date().toISOString();
      // "validated" and "scheduled" are the pipeline columns where analysis and
      // execution live. Entering either from outside arms the schedule and pokes
      // the estimator/scheduler; leaving to a non-pipeline column disarms it.
      // A task that has already reached "done" is terminal: never re-arm or
      // relaunch it, even if it is later dragged/transitioned back into a
      // pipeline column. This kills the "done task keeps relaunching" loop.
      const alreadyCompleted = task.completedAt != null;
      const enteringPipeline =
        !alreadyCompleted &&
        PIPELINE_COLUMNS.has(input.column) &&
        !PIPELINE_COLUMNS.has(task.column);
      const leavingPipeline =
        !PIPELINE_COLUMNS.has(input.column) && PIPELINE_COLUMNS.has(task.column);
      const enteringDone = input.column === "done" && task.completedAt == null;
      const moved: KanbanTask = {
        ...task,
        column: input.column,
        updatedAt: now,
        ...(enteringDone ? { completedAt: now } : {}),
        ...(input.manual ? { manualOverrideAt: now } : {}),
        // A user drag into a pipeline column is an implicit approval of the proposal.
        ...(input.manual && enteringPipeline && task.approval?.state === "pending"
          ? { approval: { ...task.approval, state: "approved" as const, approvedAt: now } }
          : {}),
        ...(enteringPipeline
          ? {
              schedule: {
                state: task.estimate ? ("awaiting_slot" as const) : ("pending_estimate" as const),
                attempts: 0,
              },
            }
          : {}),
        ...(leavingPipeline && task.schedule?.state !== "running" ? { schedule: null } : {}),
      };
      if (enteringPipeline) {
        scheduledTask = moved;
      }

      // Re-pack orders for the affected folder: target column gets the moved
      // task spliced at the requested index, the source column closes its gap.
      const folderTasks = current.tasks.filter(
        (entry) => entry.folderId === task.folderId && entry.id !== task.id,
      );
      const targetColumn = folderTasks
        .filter((entry) => entry.column === input.column)
        .sort((a, b) => a.order - b.order);
      const clampedIndex = Math.min(Math.max(input.index, 0), targetColumn.length);
      targetColumn.splice(clampedIndex, 0, moved);

      const reOrdered = new Map<string, number>();
      targetColumn.forEach((entry, index) => reOrdered.set(entry.id, index));
      for (const column of ["backlog", "validated", "scheduled", "in_progress", "done"] as const) {
        if (column === input.column) {
          continue;
        }
        folderTasks
          .filter((entry) => entry.column === column)
          .sort((a, b) => a.order - b.order)
          .forEach((entry, index) => reOrdered.set(entry.id, index));
      }

      return {
        ...current,
        tasks: current.tasks.map((entry) => {
          const base = entry.id === task.id ? moved : entry;
          const order = reOrdered.get(base.id);
          return order === undefined || order === base.order ? base : { ...base, order };
        }),
      };
    });
    this.broadcast(board);
    if (scheduledTask) {
      this.notifyScheduled(projectId, scheduledTask);
    }
    return board;
  }

  async deleteTask(projectId: string, taskId: string): Promise<void> {
    const board = await this.store.mutate(projectId, (current) => {
      if (!current.tasks.some((entry) => entry.id === taskId)) {
        throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
      }
      return { ...current, tasks: current.tasks.filter((entry) => entry.id !== taskId) };
    });
    this.broadcast(board);
  }

  /**
   * Agent-sync entry point: link the agent to an existing task with the same
   * normalized title anywhere in the project, or create a fresh card in the
   * given folder. Serialized by the store, so concurrent syncs cannot double-create.
   */
  async upsertSyncedTask(
    projectId: string,
    input: { folderId: string; title: string; agentId: string },
  ): Promise<{ task: KanbanTask; created: boolean }> {
    const normalized = normalizeTaskTitle(input.title);
    let result: { task: KanbanTask; created: boolean } | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      const existing = current.tasks.find((entry) => entry.normalizedTitle === normalized);
      if (existing) {
        const agentIds = existing.links.agentIds.includes(input.agentId)
          ? existing.links.agentIds
          : [...existing.links.agentIds, input.agentId];
        const updated: KanbanTask = {
          ...existing,
          links: {
            ...existing.links,
            agentIds,
            primaryAgentId: existing.links.primaryAgentId ?? input.agentId,
          },
          updatedAt: new Date().toISOString(),
        };
        result = { task: updated, created: false };
        return {
          ...current,
          tasks: current.tasks.map((entry) => (entry.id === existing.id ? updated : entry)),
        };
      }
      const now = new Date().toISOString();
      const siblings = current.tasks.filter(
        (entry) => entry.folderId === input.folderId && entry.column === "backlog",
      );
      const created: KanbanTask = {
        id: generateTaskEntityId(),
        folderId: input.folderId,
        title: input.title.trim(),
        tags: [],
        column: "backlog",
        order: siblings.length,
        origin: "agent_sync",
        normalizedTitle: normalized,
        links: { agentIds: [input.agentId], primaryAgentId: input.agentId },
        createdAt: now,
        updatedAt: now,
      };
      result = { task: created, created: true };
      return { ...current, tasks: [...current.tasks, created] };
    });
    this.broadcast(board);
    if (!result) {
      throw new TaskBoardServiceError("task_upsert_failed", "Task upsert produced no task");
    }
    return result;
  }

  /**
   * Column transition initiated by agent-sync or the scheduler. Appends the
   * task at the end of the target column and never stamps manualOverrideAt.
   */
  async transitionTask(projectId: string, taskId: string, column: TaskColumn): Promise<TaskBoard> {
    const board = await this.store.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    if (task.column === column) {
      return board;
    }
    const targetCount = board.tasks.filter(
      (entry) => entry.folderId === task.folderId && entry.column === column && entry.id !== taskId,
    ).length;
    return this.moveTask(projectId, { taskId, column, index: targetCount, manual: false });
  }

  private notifyScheduled(projectId: string, task: KanbanTask): void {
    if (this.onTaskScheduled) {
      try {
        this.onTaskScheduled(projectId, task.id);
      } catch (error) {
        this.logger.warn({ err: error, taskId: task.id }, "onTaskScheduled callback failed");
      }
    }
  }

  private async mutateTask(
    projectId: string,
    taskId: string,
    patch: (task: KanbanTask) => KanbanTask,
  ): Promise<TaskBoard> {
    const board = await this.store.mutate(projectId, (current) => {
      const task = current.tasks.find((entry) => entry.id === taskId);
      if (!task) {
        throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
      }
      const updated = { ...patch(task), id: task.id, updatedAt: new Date().toISOString() };
      return {
        ...current,
        tasks: current.tasks.map((entry) => (entry.id === taskId ? updated : entry)),
      };
    });
    this.broadcast(board);
    return board;
  }

  private requireTask(board: TaskBoard, taskId: string): KanbanTask {
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    return task;
  }
}
