import type pino from "pino";
import deepEqual from "fast-deep-equal";
import type {
  KanbanTask,
  TaskApproval,
  TaskBilling,
  TaskBoard,
  TaskColumn,
  TaskDeployBatch,
  TaskFolder,
  TaskRunConfig,
  TaskSchedulePreference,
  TaskUsage,
} from "@getpaseo/protocol/tasks/types";
import { backfillTaskBilling, slugifyBranch } from "./agent-launch.js";
import { settleDeployedRestartFlags } from "./restart-impact.js";
import { TaskBoardStore, generateTaskEntityId } from "./store.js";

export type TaskBoardListener = (board: TaskBoard) => void;
export type TaskCompletedListener = (projectId: string, task: KanbanTask) => void | Promise<void>;
/**
 * Fired the moment a card becomes archived, through either door: the terminal
 * "archived" column (automatic, once its work went live) or the manual hide
 * (`archivedAt`). Wired at bootstrap to the session closer, which closes the
 * card's conversation so its tab leaves the band.
 */
export type TaskArchivedListener = (projectId: string, task: KanbanTask) => void | Promise<void>;

/**
 * Answers "will publishing this card's work need a daemon restart?" — resolved
 * from the files the next publication will carry (see restart-impact.ts).
 * `null` means "cannot tell": the card's existing flag is then left alone.
 */
export type TaskRestartImpactResolver = (
  projectId: string,
  task: KanbanTask,
) => Promise<boolean | null>;

// Columns where the scheduler runs analysis + execution. "validated" is the
// consent gate: dropping a task here starts the automated pipeline. "scheduled"
// remains a valid direct-drop entry point (and the queued-for-launch state).
const PIPELINE_COLUMNS = new Set<TaskColumn>(["validated", "scheduled"]);

// The columns where nothing ever happens on its own. A card sent back here is
// back to being a draft.
const INERT_COLUMNS = new Set<TaskColumn>(["notes", "backlog"]);

/**
 * "À déployer" is reachable ONLY from "Terminée" — the board's one hard ordering
 * rule, enforced here rather than in the UI so no caller can bypass it.
 *
 * Why it exists: the column used to be entered automatically the instant a card
 * finished, which made "Terminée" an empty column nobody ever saw the work rest
 * in. That auto-hop is gone, but several callers can still move a card (the
 * user's drag, the card's own agent through `move_task`, the batch publisher,
 * the archive restore). One of them slipping a running card straight into the
 * publication queue would silently skip completion — and skip the user's own
 * press that owns it. So the service refuses the jump outright.
 *
 * A card that already carries `completedAt` is allowed: that is the archive
 * restore ("Désarchiver" puts a shipped card back where it was) and a re-entry
 * from "À déployer" itself, neither of which skips anything.
 */
function isDeployedReachableFrom(task: KanbanTask): boolean {
  return task.column === "done" || task.column === "deployed" || task.completedAt != null;
}

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
/**
 * Stamps completedAt the first time a card reaches a terminal column.
 *
 * The last column is the publication QUEUE ("À déployer"), not a claim that the
 * work is live: a finished card lands there on its own and waits for the batch
 * publication. So entering it never stamps `deployedAt` — that stamp means "this
 * is online" and is written by {@link TaskBoardService.markTaskDeployed} once a
 * publication actually succeeded. The stamp is kept as a belt-and-braces backfill
 * for cards that predate {@link isDeployedReachableFrom}, which now forbids
 * entering the queue without having completed first.
 */
function stampTerminalDates(
  task: KanbanTask,
  column: TaskColumn,
  now: string,
): Partial<KanbanTask> {
  if (column !== "done" && column !== "deployed") {
    return {};
  }
  const patch: Partial<KanbanTask> = {};
  if (task.completedAt == null) {
    patch.completedAt = now;
  }
  // `planReadyAt` is a "come review the plan" flag; a card that reached a terminal
  // column is no longer waiting on a plan, so drop it or it lingers as a stale
  // « Plan prêt » badge. The client guards against this defensively too, but
  // clearing the stored flag keeps board state honest for any reader.
  if (task.planReadyAt != null) {
    patch.planReadyAt = null;
  }
  return patch;
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
  "archived",
] as const satisfies readonly TaskColumn[];

/**
 * Compute the task as it lands in its target column: stamp completion/deploy
 * timestamps, arm or disarm the schedule, and auto-approve an implicit drag.
 *
 * - "validated"/"scheduled" are the pipeline columns: entering one from outside
 *   arms the schedule (the scheduler/estimator then pick it up); leaving disarms
 *   it. A task that already reached "done" is terminal — never re-arm it, even if
 *   dragged back into a pipeline column (kills the "done keeps relaunching" loop).
 * - "done" stamps completedAt; "deployed" (the publication queue) is reachable
 *   from "done" only — see {@link isDeployedReachableFrom}. It never stamps
 *   deployedAt — being queued is not being live.
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
  const enteringArchive = input.column === "archived" && task.column !== "archived";
  const leavingArchive = task.column === "archived" && input.column !== "archived";
  const moved: KanbanTask = {
    ...task,
    ...(returningToDraft ? resetToDraft(task) : {}),
    column: input.column,
    updatedAt: now,
    // Remember where a card came from as it enters "Archivé", so "Désarchiver"
    // can put it back exactly there. Cleared once it leaves the archive again.
    ...(enteringArchive ? { preArchiveColumn: task.column } : {}),
    ...(leavingArchive ? { preArchiveColumn: null } : {}),
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
  private onTaskArchived: TaskArchivedListener | null = null;
  private onResolveRestartImpact: TaskRestartImpactResolver | null = null;
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
   * Wires "an archived card closes its conversation". Both doors into the
   * archive report here — the terminal column and the manual hide — so the
   * listener never has to guess which gesture archived the card.
   */
  setOnTaskArchived(callback: TaskArchivedListener | null): void {
    this.onTaskArchived = callback;
  }

  /**
   * Wires the automatic "Redémarrage requis" verdict, computed the moment a card
   * reaches "Terminée" so the user knows BEFORE publishing whether the daemon
   * will have to be restarted. Wired at bootstrap; unset in tests.
   */
  setRestartImpactResolver(callback: TaskRestartImpactResolver | null): void {
    this.onResolveRestartImpact = callback;
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

  /**
   * Fills any missing Facturation fields on every task's estimate the moment the
   * board leaves the service (a read or a push), without re-persisting anything.
   * This is the read-time safety net for estimates written by a daemon that
   * predated the billing backfill: those carry null billing and never re-analyze,
   * so without this the Facturation tab (and the folder totals / compta line that
   * read the same fields) would stay blank forever. See {@link backfillTaskBilling}.
   */
  private normalizeBoard(board: TaskBoard): TaskBoard {
    let changed = false;
    const tasks = board.tasks.map((task) => {
      const filled = backfillTaskBilling(task);
      if (filled !== task) {
        changed = true;
      }
      return filled;
    });
    return changed ? { ...board, tasks } : board;
  }

  private broadcast(board: TaskBoard): void {
    const set = this.listeners.get(board.projectId);
    if (!set) {
      return;
    }
    const normalized = this.normalizeBoard(board);
    for (const listener of set) {
      try {
        listener(normalized);
      } catch (error) {
        this.logger.warn({ err: error, projectId: board.projectId }, "Task board listener failed");
      }
    }
  }

  async getBoard(projectId: string): Promise<TaskBoard> {
    return this.normalizeBoard(await this.store.getBoard(projectId));
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
    // does — the title tidy-up, the analysis, the execution, the deploy check —
    // happens in that single conversation, so opening the card months later shows
    // the whole story in order. A proposal awaiting approval gets no agent yet:
    // the user has not accepted the work.
    if (input.approval?.state !== "pending") {
      this.notifyTaskCreated(projectId, created);
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
      deployHold?: boolean | null;
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
      // "Retirer du prochain lot": held back from the batch, still on the board.
      if (changes.deployHold === null || changes.deployHold === false) {
        delete updated.deployHold;
      } else if (changes.deployHold === true) {
        updated.deployHold = true;
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
   * Resolve a chat task proposal — the ONLY path that turns a proposal into a
   * board card. `approve` creates exactly one task in "À faire" (backlog) from the
   * carried payload; never "Validé", because entering the pipeline stays the
   * user's separate consent gesture. `refuse` records the refusal and writes
   * nothing to the board.
   *
   * Idempotent by proposalId: a proposal already resolved returns its first
   * outcome (the same task on approve, null on refuse). The proposal id is
   * reserved in one serialized mutate BEFORE the task is created, so a double-tap,
   * a reload, or a second device can never mint a duplicate. The resolution is
   * persisted on the board so the chat tray stays honest across reloads.
   */
  async resolveProposal(
    projectId: string,
    input: {
      proposalId: string;
      outcome: "approve" | "refuse";
      proposal?: {
        title: string;
        description?: string;
        tags?: string[];
        folderName?: string;
        runConfig?: TaskRunConfig;
      };
    },
  ): Promise<KanbanTask | null> {
    const findExistingTask = (board: TaskBoard): KanbanTask | null => {
      const prior = board.proposalResolutions?.find((r) => r.proposalId === input.proposalId);
      if (prior?.outcome === "approved" && prior.taskId) {
        return board.tasks.find((task) => task.id === prior.taskId) ?? null;
      }
      return null;
    };

    if (input.outcome === "refuse") {
      const board = await this.store.mutate(projectId, (current) => {
        if (current.proposalResolutions?.some((r) => r.proposalId === input.proposalId)) {
          return current;
        }
        return {
          ...current,
          proposalResolutions: [
            ...(current.proposalResolutions ?? []),
            { proposalId: input.proposalId, outcome: "refused" as const },
          ],
        };
      });
      this.broadcast(board);
      return findExistingTask(board);
    }

    const payload = input.proposal;
    if (!payload) {
      throw new TaskBoardServiceError(
        "proposal_payload_missing",
        "Approving a proposal requires its payload",
      );
    }

    // Reserve the proposal id first, atomically, so a concurrent approve can't
    // slip past and create a second card. If it's already resolved, hand back the
    // first outcome instead of minting a duplicate.
    let alreadyResolved = false;
    const reserved = await this.store.mutate(projectId, (current) => {
      if (current.proposalResolutions?.some((r) => r.proposalId === input.proposalId)) {
        alreadyResolved = true;
        return current;
      }
      return {
        ...current,
        proposalResolutions: [
          ...(current.proposalResolutions ?? []),
          { proposalId: input.proposalId, outcome: "approved" as const },
        ],
      };
    });
    if (alreadyResolved) {
      return findExistingTask(reserved);
    }

    const folderId = payload.folderName?.trim()
      ? await this.ensureFolder(projectId, payload.folderName.trim())
      : await this.ensureDefaultFolder(projectId);
    // No approval marker: an approved proposal is a plain "À faire" card. Sliding
    // it into "Validé" stays the user's own, separate consent gesture.
    const created = await this.createTask(projectId, {
      folderId,
      title: payload.title,
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.tags ? { tags: payload.tags } : {}),
      origin: "agent_sync",
      ...(payload.runConfig ? { runConfig: payload.runConfig } : {}),
    });
    // Backfill the reserved resolution with the created task's id.
    const board = await this.store.mutate(projectId, (current) => ({
      ...current,
      proposalResolutions: (current.proposalResolutions ?? []).map((r) =>
        r.proposalId === input.proposalId ? { ...r, taskId: created.id } : r,
      ),
    }));
    this.broadcast(board);
    return created;
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
    let justArchived = false;
    const board = await this.mutateTask(projectId, taskId, (task) => {
      const isTerminal = task.column === "done" || task.column === "deployed";
      if (archived) {
        if (!isTerminal || task.archivedAt) {
          return task;
        }
        justArchived = true;
        return { ...task, archivedAt: new Date().toISOString() };
      }
      if (!task.archivedAt) {
        return task;
      }
      const updated = { ...task };
      delete updated.archivedAt;
      return updated;
    });
    const task = this.requireTask(board, taskId);
    if (justArchived) {
      this.notifyArchived(projectId, task);
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
    let completedTask: KanbanTask | null = null;
    let archivedTask: KanbanTask | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      const task = current.tasks.find((entry) => entry.id === input.taskId);
      if (!task) {
        throw new TaskBoardServiceError("task_not_found", `Task not found: ${input.taskId}`);
      }
      if (input.column === "deployed" && !isDeployedReachableFrom(task)) {
        // Logged, not just thrown: a refused move is invisible on the board (the
        // card stays put), so without this line "j'ai déplacé la carte et rien
        // ne s'est passé" leaves no trace at all. Grep: "Refused task move".
        this.logger.warn(
          { projectId, taskId: input.taskId, from: task.column, to: input.column },
          "Refused task move: the publication queue is reachable from « Terminé » only",
        );
        throw new TaskBoardServiceError(
          "invalid_transition",
          `Task ${input.taskId} cannot enter "deployed" from "${task.column}": a card reaches the publication queue through "done" only.`,
        );
      }
      const now = new Date().toISOString();
      const { moved, enteringPipeline } = applyColumnMove(task, input, now);
      if (enteringPipeline) {
        scheduledTask = moved;
      }
      if (input.column === "done" && task.column !== "done") {
        completedTask = moved;
      }
      if (input.column === "archived" && task.column !== "archived") {
        archivedTask = moved;
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
    if (completedTask) {
      // Fire-and-forget: the verdict costs a couple of git reads and must never
      // delay (or fail) the move itself. It lands as a second board push.
      void this.refreshRestartImpact(projectId, completedTask);
      // EVERY path into "Terminée" ends here — the user's drag, the final-check
      // bar (the agent's move_task) and the scheduler alike — so this is the one
      // place the completion listener can fire without missing a door. It used to
      // live in transitionTask only, which the two gestures a human actually uses
      // never go through: a card finished from the board simply never told anyone.
      this.notifyCompleted(projectId, completedTask);
    }
    if (archivedTask) {
      // Filed away: its conversation has nothing left to say, so the tab goes.
      this.notifyArchived(projectId, archivedTask);
    }
    return board;
  }

  /** Runs the archive listener without ever letting it break the move. */
  private notifyArchived(projectId: string, task: KanbanTask): void {
    const listener = this.onTaskArchived;
    if (!listener) {
      return;
    }
    void Promise.resolve(listener(projectId, task)).catch((error) => {
      this.logger.warn(
        { err: error, projectId, taskId: task.id },
        "onTaskArchived callback failed",
      );
    });
  }

  /** Runs the completion listener without ever letting it break the move. */
  private notifyCompleted(projectId: string, task: KanbanTask): void {
    const listener = this.onTaskCompleted;
    if (!listener) {
      return;
    }
    void Promise.resolve(listener(projectId, task)).catch((error) => {
      this.logger.warn(
        { err: error, projectId, taskId: task.id },
        "onTaskCompleted callback failed",
      );
    });
  }

  /**
   * Stamps the card's "Redémarrage requis" verdict once it reaches "Terminée".
   * Deliberately best-effort: an unresolved verdict (`null`) leaves whatever the
   * card already carried, so a flag an agent set by hand is never wiped.
   */
  private async refreshRestartImpact(projectId: string, task: KanbanTask): Promise<void> {
    const resolve = this.onResolveRestartImpact;
    if (!resolve) {
      return;
    }
    try {
      const needsDaemonRestart = await resolve(projectId, task);
      if (needsDaemonRestart === null) {
        return;
      }
      await this.patchTask(projectId, task.id, (current) =>
        current.needsDaemonRestart === needsDaemonRestart
          ? current
          : { ...current, needsDaemonRestart },
      );
    } catch (error) {
      this.logger.warn(
        { err: error, projectId, taskId: task.id },
        "Failed to resolve daemon-restart impact",
      );
    }
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
   * Ajoute une consommation modèle au compteur d'une carte, SANS toucher à
   * `updatedAt`.
   *
   * Même précaution que `markTaskViewed` : les colonnes sont triées par dernière
   * modification, et un fournisseur annonce sa consommation en continu. Passer
   * par la voie normale ferait remonter la carte en tête de colonne toutes les
   * dix secondes tant qu'un agent travaille — le tableau se réordonnerait tout
   * seul sous les yeux de l'utilisateur.
   *
   * Renvoie null quand la carte n'existe pas : un compteur n'est jamais une
   * raison de faire échouer quoi que ce soit.
   */
  async addTaskUsage(
    projectId: string,
    taskId: string,
    delta: Omit<TaskUsage, "updatedAt">,
  ): Promise<TaskBoard | null> {
    let changed = false;
    const board = await this.store.mutate(projectId, (current) => {
      const task = current.tasks.find((entry) => entry.id === taskId);
      if (!task) {
        return current;
      }
      changed = true;
      const previous = task.usage;
      const usage: TaskUsage = {
        inputTokens: (previous?.inputTokens ?? 0) + delta.inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + delta.outputTokens,
        cachedInputTokens: (previous?.cachedInputTokens ?? 0) + delta.cachedInputTokens,
        costUsd: (previous?.costUsd ?? 0) + delta.costUsd,
        turns: (previous?.turns ?? 0) + delta.turns,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...current,
        tasks: current.tasks.map((entry) => (entry.id === taskId ? { ...entry, usage } : entry)),
      };
    });
    if (!changed) {
      return null;
    }
    this.broadcast(board);
    return board;
  }

  /**
   * The one place that records "this card's work is LIVE": stamps `deployedAt`
   * (once), the address it went live at, and closes any open deploy window.
   *
   * A card only reaches this once a publication actually succeeded. Because that
   * is also the moment its work stops belonging in the "À déployer" queue, this
   * is the SINGLE, automatic, one-way door into the terminal "archived" column —
   * the card is stamped live and then filed away so the queue only ever shows
   * what still needs publishing. Nothing else moves a card to "archived", and
   * archived cards are frozen (read-only) from there on.
   */
  async markTaskDeployed(
    projectId: string,
    taskId: string,
    input: { url?: string | null; needsDaemonRestart?: boolean; sha?: string | null } = {},
  ): Promise<KanbanTask> {
    const now = new Date().toISOString();
    const stamped = await this.patchTask(projectId, taskId, (current) => ({
      ...current,
      deployedAt: current.deployedAt ?? now,
      ...(input.url ? { deployedUrl: input.url } : {}),
      // The exact version this card's work went online in. Recorded because
      // "Déployé" alone leaves the honest question "yes, but WHICH build?"
      // unanswerable once a second publication has followed.
      ...(input.sha ? { deployedSha: input.sha } : {}),
      ...(input.needsDaemonRestart !== undefined
        ? { needsDaemonRestart: input.needsDaemonRestart }
        : {}),
      deployment: { state: "deployed" as const, startedAt: current.deployment?.startedAt },
    }));
    // Its work is live: file it in the terminal "archived" column so it no longer
    // clutters the publication queue. Idempotent — a card already archived stays put.
    if (stamped.column !== "archived") {
      const board = await this.transitionTask(projectId, taskId, "archived");
      return this.requireTask(board, taskId);
    }
    return stamped;
  }

  /**
   * Records where the project's batch publication stands, on the BOARD rather
   * than on a card: it is one run covering several cards, and the column shows
   * it as a single progress bar, then as a "voici ce qui vient d'être mis en
   * ligne" recap. Passing null clears the record.
   */
  async setDeployBatch(projectId: string, batch: TaskDeployBatch | null): Promise<TaskBoard> {
    const board = await this.store.mutate(projectId, (current) => {
      if (batch === null) {
        const { deployBatch: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, deployBatch: batch };
    });
    this.broadcast(board);
    return board;
  }

  /** Merges a patch into the current batch record; no-op when none is running. */
  async patchDeployBatch(
    projectId: string,
    patch: Partial<TaskDeployBatch>,
  ): Promise<TaskDeployBatch | null> {
    let result: TaskDeployBatch | null = null;
    const board = await this.store.mutate(projectId, (current) => {
      if (!current.deployBatch) {
        return current;
      }
      result = { ...current.deployBatch, ...patch };
      return { ...current, deployBatch: result };
    });
    if (result) {
      this.broadcast(board);
    }
    return result;
  }

  /**
   * After a successful publish, mark every card whose work just went live as
   * deployed — promoting the finished ("done") ones into the "À déployer" column
   * on the way, and stamping the ones already queued there. When `branches` is a
   * set, only cards belonging to a folder (or task) on one of those merged
   * branches are touched — the precise "these branches were shipped" case. When
   * `branches` is null (a plain publish with no branch merges) nothing happens:
   * we cannot attribute the ship to specific cards.
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
    const shipped = board.tasks.filter(
      (task) =>
        (task.column === "done" || (task.column === "deployed" && task.deployedAt == null)) &&
        !task.archivedAt &&
        (branchFolderIds.has(task.folderId) ||
          (task.links.branch != null && input.branches?.has(task.links.branch))),
    );
    for (const task of shipped) {
      if (task.column !== "deployed") {
        await this.transitionTask(input.projectId, task.id, "deployed");
      }
      await this.markTaskDeployed(input.projectId, task.id);
    }
    return shipped.length;
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
   * One-time migration, run at boot: before the publication queue existed, the
   * last column meant "already deployed" — every card in it had gone live. The
   * queue reversed that meaning, so those legacy cards would now read as "waiting
   * to be published", and the first "Tout déployer" would offer to re-publish the
   * whole history (109 cards on the real board, every branch merged again).
   *
   * So the first daemon that opens a board with the new meaning stamps every card
   * already sitting in that column as live — which is what they truthfully are —
   * and records that it did. Idempotent: the marker makes it a no-op forever
   * after, so a card queued later is never mistaken for history.
   */
  async backfillLegacyDeployedCards(projectId: string): Promise<number> {
    try {
      // Read before writing: boot runs this for every known project, and
      // store.mutate would otherwise create a board file for projects with none.
      const current = await this.store.getBoard(projectId);
      if (current.legacyDeployedBackfilledAt) {
        return 0;
      }
      const legacy = current.tasks.filter(
        (task) =>
          task.column === "deployed" &&
          task.deployedAt == null &&
          task.deployedUrl == null &&
          task.deployment?.state !== "deployed",
      );
      const stampedAt = new Date().toISOString();
      const board = await this.store.mutate(projectId, (latest) => {
        if (latest.legacyDeployedBackfilledAt) {
          return latest;
        }
        const ids = new Set(legacy.map((task) => task.id));
        return {
          ...latest,
          legacyDeployedBackfilledAt: stampedAt,
          tasks: latest.tasks.map((task) =>
            ids.has(task.id) && task.deployedAt == null
              ? { ...task, deployedAt: task.completedAt ?? task.updatedAt }
              : task,
          ),
        };
      });
      this.broadcast(board);
      if (legacy.length > 0) {
        this.logger.info(
          { projectId, count: legacy.length },
          "Legacy deployed cards stamped as live (publication queue migration)",
        );
      }
      return legacy.length;
    } catch (error) {
      this.logger.warn({ err: error, projectId }, "Failed to backfill legacy deployed cards");
      return 0;
    }
  }

  /**
   * Boot-time housekeeping: a daemon that has just started IS running the
   * current code, so no already-published card is waiting on a restart any more.
   * Clearing those flags is what stops the card's "Redémarrer le moteur" bar
   * from being offered forever (and hiding the "Archiver" bar it shares a slot
   * with). Best-effort and idempotent — an untouched board is never rewritten.
   */
  /**
   * At boot, close any batch publication left frozen on "running".
   *
   * The run's progress is advanced by an IN-MEMORY watcher (TaskBatchDeployer),
   * and the stall/timeout safety nets live inside that same loop. When the engine
   * restarts mid-publication — a crash, a manual restart, or the deploy's own
   * final restart firing while a sibling run is still open — the watcher dies with
   * the process, but the board record persists. Nothing left alive would ever move
   * it off "running": the banner then spins forever, with no elapsed time, no log
   * verdict, and (because "Réinitialiser / Relancer" only shows on a failure) no
   * way out. This turns that orphan into an honest, actionable failure so the
   * escape hatch appears.
   *
   * A genuinely successful run stamps its record "success" BEFORE requesting the
   * restart, so a record still on "running" at boot is always an interrupted one.
   * No card was stamped live, so nothing is lost: a re-run republishes, or drops
   * cleanly if the work already reached production.
   */
  async reconcileOrphanDeployBatch(projectId: string): Promise<void> {
    try {
      const current = await this.store.getBoard(projectId);
      if (current.deployBatch?.state !== "running") {
        return;
      }
      const board = await this.store.mutate(projectId, (latest) =>
        latest.deployBatch?.state === "running"
          ? {
              ...latest,
              deployBatch: {
                ...latest.deployBatch,
                state: "failed" as const,
                finishedAt: new Date().toISOString(),
                queued: false,
                error:
                  "La publication a été interrompue par un redémarrage du moteur. Rien n'a été mis en ligne — relancez « Tout déployer » si besoin.",
              },
            }
          : latest,
      );
      this.broadcast(board);
      this.logger.info({ projectId }, "Orphan running deploy batch settled to failed at boot");
    } catch (error) {
      this.logger.warn({ err: error, projectId }, "Failed to reconcile an orphan deploy batch");
    }
  }

  async settleRestartFlags(projectId: string): Promise<void> {
    try {
      // Read before writing. `store.mutate` persists unconditionally, so going
      // straight to it would create a board file for every project the daemon
      // knows — including the ones that never had a single card — and push a
      // board update to their subscribers, on every single boot.
      const current = await this.store.getBoard(projectId);
      if (settleDeployedRestartFlags(current.tasks) === current.tasks) {
        return;
      }
      const board = await this.store.mutate(projectId, (latest) => ({
        ...latest,
        tasks: settleDeployedRestartFlags(latest.tasks),
      }));
      this.broadcast(board);
    } catch (error) {
      this.logger.warn({ err: error, projectId }, "Failed to settle daemon-restart flags");
    }
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
    // The completion listener is fired by moveTask itself (every door goes
    // through it), so there is nothing to do here.
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

  /**
   * Same card, ignoring the last-modified stamp — which is the one field the
   * stamp itself must not be allowed to justify rewriting.
   */
  private static isSameTask(left: KanbanTask, right: KanbanTask): boolean {
    const { updatedAt: _left, ...restLeft } = left;
    const { updatedAt: _right, ...restRight } = right;
    return deepEqual(restLeft, restRight);
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
      const patched = { ...patch(task), id: task.id };
      // A patch that changes nothing must change nothing. Restamping `updatedAt`
      // regardless is what made cards shuffle on their own: every column is
      // sorted by last-modified, and background writes that decide "no change"
      // (the restart-impact verdict, a re-read estimate) still bumped the stamp
      // and pushed a fresh board, so a card the user was reading jumped to the
      // top of its column for no reason at all.
      if (TaskBoardService.isSameTask(task, patched)) {
        return current;
      }
      const updated = { ...patched, updatedAt: new Date().toISOString() };
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
    // Single-task mutation returns feed RPC responses; fill the Facturation
    // fields here too so a returned task never disagrees with the normalized
    // board snapshot (see normalizeBoard / backfillTaskBilling).
    return backfillTaskBilling(task);
  }
}
