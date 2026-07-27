import type pino from "pino";
import type {
  KanbanTask,
  TaskApproval,
  TaskBilling,
  TaskBoard,
  TaskColumn,
  TaskFolder,
  TaskRunConfig,
  TaskSchedulePreference,
} from "@getpaseo/protocol/tasks/types";
import { slugifyBranch } from "./agent-launch.js";
import { TaskBoardStore, generateTaskEntityId } from "./store.js";

export type TaskBoardListener = (board: TaskBoard) => void;
export type TaskCompletedListener = (projectId: string, task: KanbanTask) => void | Promise<void>;

// Columns where the scheduler runs analysis + execution. "validated" is the
// consent gate: dropping a task here starts the automated pipeline. "scheduled"
// remains a valid direct-drop entry point (and the queued-for-launch state).
const PIPELINE_COLUMNS = new Set<TaskColumn>(["validated", "scheduled"]);

// The columns where nothing ever happens on its own. A card sent back here is
// back to being a draft.
const INERT_COLUMNS = new Set<TaskColumn>(["notes", "backlog"]);

/**
 * Everything a run leaves behind on a card, wiped when the user drags it back to
 * "À faire" (or "Notes"). Dragging a card back there is the "start this one
 * over" gesture: it must not keep a cost estimate, a half-finished progress
 * sub-status, a recorded analysis failure, a plan, a pause or an open final
 * check — all of which would otherwise decide how the card behaves the next
 * time it is validated.
 *
 * Two things are deliberately KEPT:
 * - `links` (the agent and its conversation). The card's history is never
 *   erased — that is the whole point of one agent per task. A reset starts the
 *   work over, not the story.
 * - `billing`, which records that this task's line was already added to an
 *   invoice. Clearing it would invite invoicing the same work twice.
 */
/** Stamps completedAt / deployedAt the first time a card reaches a terminal column. */
function stampTerminalDates(
  task: KanbanTask,
  column: TaskColumn,
  now: string,
): Partial<KanbanTask> {
  if (column === "done" && task.completedAt == null) {
    return { completedAt: now };
  }
  if (column === "deployed" && task.deployedAt == null) {
    // A card that jumped straight to "deployed" never got its completion stamp.
    return { deployedAt: now, ...(task.completedAt == null ? { completedAt: now } : {}) };
  }
  return {};
}

function resetToDraft(task: KanbanTask): Partial<KanbanTask> {
  const cleared: Partial<KanbanTask> = {
    estimate: null,
    schedule: null,
    analysis: null,
    progress: null,
    validation: null,
    planReadyAt: null,
    completedAt: null,
    deployedAt: null,
  };
  if (task.executionHold !== undefined) {
    cleared.executionHold = false;
  }
  return cleared;
}

// The kanban columns, in board order. "notes" is the leftmost draft column
// (inert: never in PIPELINE_COLUMNS, so no estimate/execution); the last entry
// is terminal.
// The one list every project gets now that folders are gone from the product.
const DEFAULT_TASK_LIST_NAME = "Tâches";

const COLUMN_ORDER = [
  "notes",
  "backlog",
  "validated",
  "scheduled",
  "in_progress",
  "done",
  "deployed",
] as const satisfies readonly TaskColumn[];

/**
 * Compute the task as it lands in its target column: stamp completion/deploy
 * timestamps, arm or disarm the schedule, and auto-approve an implicit drag.
 *
 * - "validated"/"scheduled" are the pipeline columns: entering one from outside
 *   arms the schedule (the scheduler/estimator then pick it up); leaving disarms
 *   it. A task that already reached "done" is terminal — never re-arm it, even if
 *   dragged back into a pipeline column (kills the "done keeps relaunching" loop).
 * - "done" stamps completedAt; "deployed" (terminal, post-"done") stamps
 *   deployedAt and backfills completedAt if the task jumped straight there.
 * - dragging a card back into an INERT column ("À faire"/"Notes") RESETS it: see
 *   {@link resetToDraft}. That is the user's "start this one over" gesture.
 */
function applyColumnMove(
  task: KanbanTask,
  input: MoveTaskInput,
  now: string,
): { moved: KanbanTask; enteringPipeline: boolean } {
  const alreadyCompleted = task.completedAt != null;
  const enteringPipeline =
    !alreadyCompleted && PIPELINE_COLUMNS.has(input.column) && !PIPELINE_COLUMNS.has(task.column);
  const leavingPipeline = !PIPELINE_COLUMNS.has(input.column) && PIPELINE_COLUMNS.has(task.column);
  const returningToDraft = INERT_COLUMNS.has(input.column) && !INERT_COLUMNS.has(task.column);
  const moved: KanbanTask = {
    ...task,
    ...(returningToDraft ? resetToDraft(task) : {}),
    column: input.column,
    updatedAt: now,
    ...stampTerminalDates(task, input.column, now),
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
  return { moved, enteringPipeline };
}

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
  attachments?: KanbanTask["attachments"];
  column?: TaskColumn;
  origin?: KanbanTask["origin"];
  agentId?: string;
  runConfig?: TaskRunConfig;
  schedulePreference?: TaskSchedulePreference;
  // "pending" gates the scheduler until the user approves (agent proposals).
  approval?: TaskApproval;
  // Historically meant "spawn this task's agent right away". Superseded: EVERY
  // card now gets its agent at creation, so the flag is accepted (old clients
  // still send it) and no longer changes anything. It deliberately does NOT arm
  // the execution pipeline — reaching "Validé" is the user's act alone.
  // COMPAT(taskCreateLaunch): accepted since v0.2.2, drop once no client sends it.
  launch?: boolean;
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
  private onTaskCompleted: TaskCompletedListener | null = null;
  private onBacklogRefine: ((projectId: string, taskId: string) => void) | null = null;
  private onTaskCreated: ((projectId: string, task: KanbanTask) => void) | null = null;

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

  setOnTaskCompleted(callback: TaskCompletedListener | null): void {
    this.onTaskCompleted = callback;
  }

  /**
   * Fired when a manual backlog task needs light analysis (title + tidied
   * prompt). Wired to the light analyzer at bootstrap. NEVER triggers the cost
   * estimate — that's onTaskScheduled, and only fires from "Validé" onward.
   */
  setOnBacklogRefine(callback: (projectId: string, taskId: string) => void): void {
    this.onBacklogRefine = callback;
  }

  /**
   * Fired the moment a card is born, so its agent is attached before anything
   * else happens to it. Wired to the agent provisioner at bootstrap. Attaching
   * an agent costs nothing on its own — it opens a conversation, it does not
   * spend quota — so this does NOT breach the "backlog is inert" rule: no
   * estimate, no billing, no execution.
   */
  setOnTaskCreated(callback: (projectId: string, task: KanbanTask) => void): void {
    this.onTaskCreated = callback;
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
    requireValidation?: boolean,
  ): Promise<TaskFolder> {
    let created: TaskFolder | null = null;
    const resolvedBranch = deriveFolderBranch(name, branch);
    const board = await this.store.mutate(projectId, (current) => {
      created = {
        id: generateTaskEntityId(),
        name: name.trim(),
        ...(color ? { color } : {}),
        ...(requireValidation !== undefined ? { requireValidation } : {}),
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
      requireValidation?: boolean;
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
        ...(changes.requireValidation !== undefined
          ? { requireValidation: changes.requireValidation }
          : {}),
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
   * The project's single task list. Folders are gone from the product: every
   * task lives in one list and runs on the project's main branch. This keeps ONE
   * folder record per project because the persisted task shape still carries a
   * folderId — callers never choose it any more.
   *
   * Race-safe: serialized by the store, so two concurrent creates cannot mint
   * two lists.
   */
  async ensureDefaultFolder(projectId: string): Promise<string> {
    let folderId: string | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      const existing = current.folders[0];
      if (existing) {
        folderId = existing.id;
        return current;
      }
      const created: TaskFolder = {
        id: generateTaskEntityId(),
        name: DEFAULT_TASK_LIST_NAME,
        order: 0,
        createdAt: new Date().toISOString(),
      };
      folderId = created.id;
      return { ...current, folders: [created] };
    });
    this.broadcast(board);
    if (!folderId) {
      throw new TaskBoardServiceError("folder_create_failed", "Failed to ensure the task list");
    }
    return folderId;
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
    // Folders are gone from the product: an unknown (or empty) folder id simply
    // lands in the project's single list instead of failing.
    const board = await this.store.getBoard(projectId);
    const folderId = board.folders.some((entry) => entry.id === input.folderId)
      ? input.folderId
      : await this.ensureDefaultFolder(projectId);
    // Default to "À faire"; a caller may explicitly ask for another INERT column
    // ("Notes"). The pipeline columns are never an entry point here: reaching
    // them is the user's consent act (a drag, or an approval), never a side
    // effect of creating a card. Silently forcing every creation into "backlog"
    // was also why a card created from "Notes" appeared to jump columns on its
    // own.
    const requested = input.column ?? "backlog";
    const column: TaskColumn = requested === "notes" ? "notes" : "backlog";
    // A manual backlog card built from a pasted prompt gets a LIGHT analysis
    // (title + tidied description) — never a cost estimate. That's the whole
    // point of the gate: analysis cost only starts at "Validé".
    const needsLightAnalysis =
      (input.origin ?? "manual") === "manual" &&
      input.approval?.state !== "pending" &&
      (input.description?.trim() ?? "") !== "";
    const nextBoard = await this.store.mutate(projectId, (current) => {
      const now = new Date().toISOString();
      const siblings = current.tasks.filter((task) => task.column === column);
      created = {
        id: generateTaskEntityId(),
        folderId,
        title: input.title.trim(),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.attachments !== undefined && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
        tags: input.tags ?? [],
        column,
        order: siblings.length,
        origin: input.origin ?? "manual",
        normalizedTitle: normalizeTaskTitle(input.title),
        ...(input.runConfig !== undefined ? { runConfig: input.runConfig } : {}),
        ...(input.schedulePreference !== undefined
          ? { schedulePreference: input.schedulePreference }
          : {}),
        ...(input.approval !== undefined ? { approval: input.approval } : {}),
        // Mark pending so the refiner (and a restart re-arm) knows to clean it up.
        ...(needsLightAnalysis ? { refinement: "pending" as const } : {}),
        links: input.agentId
          ? { agentIds: [input.agentId], primaryAgentId: input.agentId }
          : { agentIds: [] },
        createdAt: now,
        updatedAt: now,
      };
      return { ...current, tasks: [...current.tasks, created] };
    });
    this.broadcast(nextBoard);
    if (!created) {
      throw new TaskBoardServiceError("task_create_failed", "Task creation produced no task");
    }
    // A card owns ONE agent, from its very first second. Everything the task ever
    // does — the title tidy-up, the analysis, the execution, the final check —
    // happens in that single conversation, so opening the card months later shows
    // the whole story in order. A proposal awaiting approval gets no agent yet:
    // the user has not accepted the work.
    if (input.approval?.state !== "pending") {
      this.notifyTaskCreated(projectId, created);
    }
    if (needsLightAnalysis) {
      this.notifyBacklogRefine(projectId, created);
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
   * The user's "À faire" → "Validé" consent gesture — the single place a card
   * enters the pipeline on purpose. It covers two shapes of card:
   *
   * - an **agent-proposed** task awaiting approval (`approval.state ===
   *   "pending"`), born in "backlog" like every other card; approving it also
   *   stamps the approval as accepted.
   * - a **plain backlog** card the user validates from the task chat's
   *   "Valider la tâche" bar. There is no approval to stamp — the move itself is
   *   the consent.
   *
   * Both move out of backlog into the "validated" consent gate and arm the
   * schedule (`pending_estimate`) so the estimator/scheduler pick the card up. A
   * proposal already sitting in a pipeline column (legacy state) keeps its column
   * and just gets armed. This is strictly user-initiated: the agent's `move_task`
   * can never reach it, which is exactly the invariant this gate exists to hold
   * (see docs/task-board-cycle.md). Any other card (already past backlog, or
   * terminal) is left untouched.
   */
  async approveTask(projectId: string, taskId: string): Promise<KanbanTask> {
    let needsScheduleNotify = false;
    const board = await this.mutateTask(projectId, taskId, (task) => {
      const isProposal = task.approval?.state === "pending";
      // Only an unapproved proposal or a plain backlog card may be validated
      // here; everything else is a no-op.
      if (!isProposal && task.column !== "backlog") {
        return task;
      }
      const now = new Date().toISOString();
      const column: TaskColumn = PIPELINE_COLUMNS.has(task.column) ? task.column : "validated";
      const updated: KanbanTask = {
        ...task,
        column,
        ...(isProposal && task.approval
          ? { approval: { ...task.approval, state: "approved" as const, approvedAt: now } }
          : {}),
      };
      // Never re-arm a task that already reached the terminal columns.
      if (PIPELINE_COLUMNS.has(column) && !task.schedule && task.completedAt == null) {
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
   * "Archiver": hide a finished card from the board. Stamps (or clears)
   * `archivedAt` and nothing else — it never changes the card's column, never
   * publishes it, and never touches the automatic done→deployed publication.
   * Archiving is orthogonal to the pipeline; the daemon keeps the card so a
   * future archived view can list and un-archive it (see docs/task-board-cycle.md).
   * Only ever offered on terminal cards, so it is a no-op unless the card is in
   * "done" or "deployed".
   */
  async archiveTask(projectId: string, taskId: string, archived: boolean): Promise<KanbanTask> {
    const board = await this.mutateTask(projectId, taskId, (task) => {
      const isTerminal = task.column === "done" || task.column === "deployed";
      if (archived) {
        if (!isTerminal || task.archivedAt) {
          return task;
        }
        return { ...task, archivedAt: new Date().toISOString() };
      }
      if (!task.archivedAt) {
        return task;
      }
      const updated = { ...task };
      delete updated.archivedAt;
      return updated;
    });
    return this.requireTask(board, taskId);
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
      const { moved, enteringPipeline } = applyColumnMove(task, input, now);
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
      for (const column of COLUMN_ORDER) {
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

  /**
   * Stamp viewedAt the first time the user opens a card. Idempotent (a card
   * already seen is left untouched) and — crucially — never bumps updatedAt, so
   * marking a card viewed does NOT reorder it in the recency sort. Returns the
   * refreshed board only when the stamp actually changed.
   */
  async markTaskViewed(projectId: string, taskId: string): Promise<TaskBoard | null> {
    let changed = false;
    const board = await this.store.mutate(projectId, (current) => {
      const task = current.tasks.find((entry) => entry.id === taskId);
      if (!task || task.viewedAt) {
        return current;
      }
      changed = true;
      const viewedAt = new Date().toISOString();
      return {
        ...current,
        tasks: current.tasks.map((entry) => (entry.id === taskId ? { ...entry, viewedAt } : entry)),
      };
    });
    if (!changed) {
      return null;
    }
    this.broadcast(board);
    return board;
  }

  /**
   * After a successful publish, promote every finished ("done") card whose work
   * just went live to the terminal "deployed" column. When `branches` is a set,
   * only cards belonging to a folder (or task) on one of those merged branches
   * move — the precise "these branches were shipped" case. When `branches` is
   * null (a plain publish with no branch merges) nothing is promoted: we cannot
   * attribute the ship to specific cards, so the user still drags those by hand.
   * Reuses transitionTask so each move stamps deployedAt and broadcasts.
   */
  async promoteDoneTasksToDeployed(input: {
    projectId: string;
    branches: Set<string> | null;
  }): Promise<number> {
    if (input.branches === null || input.branches.size === 0) {
      return 0;
    }
    const board = await this.store.getBoard(input.projectId);
    const branchFolderIds = new Set(
      board.folders
        .filter((folder) => folder.branch != null && input.branches?.has(folder.branch))
        .map((folder) => folder.id),
    );
    const doneToDeploy = board.tasks.filter(
      (task) =>
        task.column === "done" &&
        (branchFolderIds.has(task.folderId) ||
          (task.links.branch != null && input.branches?.has(task.links.branch))),
    );
    for (const task of doneToDeploy) {
      await this.transitionTask(input.projectId, task.id, "deployed");
    }
    return doneToDeploy.length;
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
    const moved = await this.moveTask(projectId, {
      taskId,
      column,
      index: targetCount,
      manual: false,
    });
    if (column === "done" && this.onTaskCompleted) {
      const completed = moved.tasks.find((entry) => entry.id === taskId);
      if (completed) {
        void Promise.resolve(this.onTaskCompleted(projectId, completed)).catch((error) => {
          this.logger.warn({ err: error, projectId, taskId }, "onTaskCompleted callback failed");
        });
      }
    }
    return moved;
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

  private notifyTaskCreated(projectId: string, task: KanbanTask): void {
    if (this.onTaskCreated) {
      try {
        this.onTaskCreated(projectId, task);
      } catch (error) {
        this.logger.warn({ err: error, taskId: task.id }, "onTaskCreated callback failed");
      }
    }
  }

  private notifyBacklogRefine(projectId: string, task: KanbanTask): void {
    if (this.onBacklogRefine) {
      try {
        this.onBacklogRefine(projectId, task.id);
      } catch (error) {
        this.logger.warn({ err: error, taskId: task.id }, "onBacklogRefine callback failed");
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
