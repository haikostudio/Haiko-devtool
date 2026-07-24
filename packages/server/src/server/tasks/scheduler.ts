import type { KanbanTask, TaskFolder } from "@getpaseo/protocol/tasks/types";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import {
  isProviderUsageExhausted,
  type ProviderUsageService,
} from "../../services/quota-fetcher/service.js";
import { DEFAULT_TASKS_QUIET_HOURS, isQuietTime, type QuietHours } from "../quiet-hours.js";
import type { TaskBoardService } from "./service.js";
import type { TaskEstimator } from "./estimator.js";
import type { TaskLightAnalyzer } from "./light-analyzer.js";
import {
  buildTaskExecutionPrompt,
  resolveTaskLaunch,
  resolveTaskWorktreePlan,
  TASK_AGENT_LABEL,
  withTaskAttachments,
} from "./agent-launch.js";
import { PASEO_DEPLOY_CONFLICT_TAG } from "../../utils/paseo-deploy.js";

export { TASK_AGENT_LABEL } from "./agent-launch.js";

const TICK_INTERVAL_MS = 30_000;
// Real concurrency is governed by the quota budget, not this number: each launch
// reserves its estimated quota%, and `hasQuotaFor` keeps launching only while the
// window still covers the next task + margin. So a batch of tiny tasks can run
// many at once while one heavy task runs alone. This is only a machine-safety
// ceiling on parallel worktrees/processes (RAM, disk, CPU) — raise it if the host
// is beefy, lower it if it thrashes.
const MAX_CONCURRENT_TASK_AGENTS = 6;
const QUOTA_SAFETY_MARGIN_PCT = 10;
const MAX_ATTEMPTS = 3;
// Interrupted (canceled) runs auto-re-queue without spending a real attempt.
// This bounds that so an instantly-canceling run can't retry forever.
const MAX_CANCEL_REQUEUES = 5;
// "Light" tasks (below both thresholds) may launch outside quiet hours in
// "auto" mode; anything heavier waits for the off-peak window.
const LIGHT_TASK_MAX_QUOTA_PCT = 25;
const LIGHT_TASK_MAX_MINUTES = 45;

interface TaskSchedulerOptions {
  taskBoardService: TaskBoardService;
  taskEstimator: TaskEstimator;
  /** Light-analysis pass for backlog cards; re-armed here after a restart. */
  taskLightAnalyzer?: Pick<TaskLightAnalyzer, "refine">;
  projectRegistry: ProjectRegistry;
  agentManager: Pick<AgentManager, "runAgent" | "appendTimelineItem" | "getLastAssistantMessage">;
  createAgent: BoundCreateAgentCommand;
  providerUsageService: Pick<ProviderUsageService, "listUsage">;
  logger: pino.Logger;
  tickIntervalMs?: number;
  /** Off-peak window for heavy tasks. Defaults to 01:00–07:00 Europe/Paris. */
  getQuietHours?: () => QuietHours;
  /** Injected for tests. */
  now?: () => number;
}

interface LaunchCandidate {
  projectId: string;
  task: KanbanTask;
  folder: TaskFolder | undefined;
  folderOrder: number;
  runNow: boolean;
}

// "Planifié" column task ready to launch: estimated, awaiting a slot, and not
// an unapproved agent proposal.
function isScheduledCandidate(task: KanbanTask): boolean {
  return (
    task.column === "scheduled" &&
    task.schedule?.state === "awaiting_slot" &&
    Boolean(task.estimate) &&
    task.approval?.state !== "pending" &&
    // "Pause au choix": held tasks are analyzed but never auto-launched.
    task.executionHold !== true
  );
}

// A "Validé" task whose analysis is done: it has an estimate, is approved, and
// isn't mid-launch. The scheduler promotes it to "Planifié" (queued for a slot).
function isValidatedReady(task: KanbanTask): boolean {
  return (
    task.column === "validated" &&
    Boolean(task.estimate) &&
    task.approval?.state !== "pending" &&
    task.schedule?.state !== "launching" &&
    task.schedule?.state !== "running" &&
    // Held tasks stay in "Validé" (with a badge) until the user gives the go.
    task.executionHold !== true
  );
}

/**
 * Executes tasks from the board. The consent gate is the "Validé" column:
 * dropping a task there starts the automated pipeline (analysis then execution).
 * - "Validé" column: analysis runs; once estimated the task is promoted to
 *   "Planifié" and launched. Backlog tasks are inert — never analyzed or run.
 * - "Planifié" column: estimated tasks awaiting a launch slot (also a valid
 *   direct-drop entry point that skips straight to the queue).
 * - Autopilot folders: the scheduler auto-validates the folder's backlog —
 *   turning autopilot on IS the consent — so execution still flows via "Validé".
 *
 * Every launch opens a fresh visible (non-internal) agent in its own isolated
 * worktree + branch (task/<slug>-<id>), so several task agents can run in the
 * SAME project concurrently without fighting over the user's checkout. The
 * agent implements the task and commits on its branch (no push, no PR); the
 * user reviews and merges. Plan-mode tasks produce a plan and stop.
 *
 * The scheduler also sweeps every pipeline task ("validated"/"scheduled") and
 * requests a cost estimate once, so the board shows real quota lengths and
 * packing can plan ahead. Backlog tasks are never estimated.
 *
 * The quota gate reads the task provider's five_hour window and only launches
 * when remaining % covers the task estimate plus a safety margin, minus
 * estimates already reserved by in-flight launches. Candidates are packed by
 * size: during quiet hours the biggest tasks launch first (spend the fresh
 * post-reset window on heavy work), during the day the lightest go first.
 *
 * Two extra gates sit in front of the quota gate:
 * - Approval: tasks with approval.state === "pending" (agent proposals) are
 *   never launched — the user must approve first.
 * - Timing: in "auto" mode, light tasks (small quota + short duration) launch
 *   anytime, heavy ones wait for the quiet-hours window (user asleep, fresh
 *   post-reset capacity). "asap" ignores the window, "off_peak" always waits.
 */
export class TaskScheduler {
  private readonly taskBoardService: TaskBoardService;
  private readonly taskEstimator: TaskEstimator;
  private readonly taskLightAnalyzer: Pick<TaskLightAnalyzer, "refine"> | null;
  private readonly projectRegistry: ProjectRegistry;
  private readonly agentManager: Pick<
    AgentManager,
    "runAgent" | "appendTimelineItem" | "getLastAssistantMessage"
  >;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly providerUsageService: Pick<ProviderUsageService, "listUsage">;
  private readonly logger: pino.Logger;
  private readonly tickIntervalMs: number;
  private readonly getQuietHours: () => QuietHours;
  private readonly now: () => number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  // taskId -> reserved quota percent for launches still in flight.
  private readonly inFlight = new Map<string, number>();
  private readonly runNowQueue = new Set<string>();
  // "projectId:folderId" of branch-folders with an active task, recomputed each
  // tick. A branch-folder runs its tasks one at a time (single shared worktree).
  private readonly busyBranchFolders = new Set<string>();
  // Open tasks already sent to the estimator this daemon lifetime — the sweep
  // estimates each task once (a failed run writes a fallback estimate anyway).
  private readonly estimateRequested = new Set<string>();

  constructor(options: TaskSchedulerOptions) {
    this.taskBoardService = options.taskBoardService;
    this.taskEstimator = options.taskEstimator;
    this.taskLightAnalyzer = options.taskLightAnalyzer ?? null;
    this.projectRegistry = options.projectRegistry;
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.providerUsageService = options.providerUsageService;
    this.logger = options.logger.child({ module: "task-scheduler" });
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.getQuietHours = options.getQuietHours ?? (() => DEFAULT_TASKS_QUIET_HOURS);
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.tickTimer) {
      return;
    }
    this.tickTimer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.warn({ err: error }, "Task scheduler tick failed");
      });
    }, this.tickIntervalMs);
    this.logger.info({ tickIntervalMs: this.tickIntervalMs }, "Task scheduler started");
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async runNow(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.approval?.state === "pending") {
      // An explicit run-now is the strongest form of user approval.
      await this.taskBoardService.approveTask(projectId, taskId);
    }
    if (task.column !== "scheduled") {
      await this.taskBoardService.transitionTask(projectId, taskId, "scheduled");
    }
    // An explicit run-now is the user's "go": lift any "pause au choix" hold so
    // the task launches now (and stays on auto afterwards).
    if (task.executionHold === true) {
      await this.taskBoardService.patchTask(projectId, taskId, (current) => {
        const next = { ...current };
        delete next.executionHold;
        return next;
      });
    }
    // Ensure the analysis agent is spawned even if this task entered the pipeline
    // without a notify (e.g. created directly in "Planifié", or after a restart).
    // No-op once the task already has an estimate/agent (guarded in the estimator).
    this.taskEstimator.requestEstimate(projectId, taskId);
    this.runNowQueue.add(`${projectId}:${taskId}`);
    void this.tick().catch((error) => {
      this.logger.warn({ err: error }, "Task scheduler run-now tick failed");
    });
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const candidates = await this.collectCandidates();
      if (candidates.length === 0) {
        return;
      }
      for (const candidate of candidates) {
        if (this.inFlight.size >= MAX_CONCURRENT_TASK_AGENTS) {
          return;
        }
        if (this.inFlight.has(candidate.task.id)) {
          continue;
        }
        // Serialize within a branch-folder: its tasks share one worktree, so hold
        // this one back while a sibling is already active (or launched this tick).
        const branchFolderKey = candidate.folder?.branch
          ? `${candidate.projectId}:${candidate.folder.id}`
          : null;
        if (branchFolderKey && this.busyBranchFolders.has(branchFolderKey)) {
          continue;
        }
        if (!candidate.runNow) {
          if (!this.isWithinLaunchWindow(candidate.task)) {
            await this.setWaitingReason(candidate, "quiet_hours");
            continue;
          }
          if (!(await this.hasQuotaFor(candidate.task))) {
            await this.setWaitingReason(candidate, "quota");
            continue;
          }
          await this.setWaitingReason(candidate, undefined);
        }
        const reserved = candidate.task.estimate?.quotaPercent ?? QUOTA_SAFETY_MARGIN_PCT;
        this.inFlight.set(candidate.task.id, reserved);
        if (branchFolderKey) {
          this.busyBranchFolders.add(branchFolderKey);
        }
        void this.launch(candidate)
          .catch((error) => {
            this.logger.error(
              { err: error, taskId: candidate.task.id, projectId: candidate.projectId },
              "Task launch failed",
            );
          })
          .finally(() => {
            this.inFlight.delete(candidate.task.id);
          });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async collectCandidates(): Promise<LaunchCandidate[]> {
    const projects = await this.projectRegistry.list();
    const candidates: LaunchCandidate[] = [];
    this.busyBranchFolders.clear();
    for (const project of projects) {
      if (project.archivedAt) {
        continue;
      }
      const board = await this.taskBoardService.getBoard(project.projectId);
      if (board.tasks.length === 0) {
        continue;
      }
      const foldersById = new Map(board.folders.map((folder) => [folder.id, folder]));
      const folderOrders = new Map(board.folders.map((folder) => [folder.id, folder.order]));
      const folderAutopilot = new Map(
        board.folders.map((folder) => [folder.id, folder.autopilot === true]),
      );
      this.markBusyBranchFolders(project.projectId, board.tasks, foldersById);
      for (let task of board.tasks) {
        if (task.column === "done" || task.column === "deployed") {
          continue;
        }
        task = await this.recoverRunningDeployConflict(project.projectId, task);
        if (task.column === "in_progress") {
          continue;
        }
        if (task.column === "backlog") {
          this.handleBacklogTask(
            project.projectId,
            task,
            folderAutopilot.get(task.folderId) === true,
          );
          continue;
        }
        task = await this.fallbackDeployConflictProvider(project.projectId, task);
        // "validated" or "scheduled": the analysis + execution pipeline.
        this.maybeSweepEstimate(project.projectId, task);
        if (task.schedule?.state === "pending_estimate") {
          // Re-arm after daemon restarts: the estimate request queue is in-memory.
          // Also runs for approval-pending proposals so the cost is ready to review.
          this.taskEstimator.requestEstimate(project.projectId, task.id);
          continue;
        }
        if (task.column === "validated") {
          // Analysis done → promote to "Planifié" so it queues for a launch slot.
          if (isValidatedReady(task)) {
            this.autoTransition(project.projectId, task.id, "scheduled");
          }
          continue;
        }
        if (!isScheduledCandidate(task)) {
          continue;
        }
        candidates.push({
          projectId: project.projectId,
          task,
          folder: foldersById.get(task.folderId),
          folderOrder: folderOrders.get(task.folderId) ?? 0,
          runNow: this.runNowQueue.has(`${project.projectId}:${task.id}`),
        });
      }
    }
    return this.sortForPacking(candidates);
  }

  // A branch-folder shares ONE worktree, so only one of its tasks may run at a
  // time. Records folders that already have an active (launching/running) task so
  // the tick loop holds their other tasks back until the slot frees up.
  private markBusyBranchFolders(
    projectId: string,
    tasks: KanbanTask[],
    foldersById: Map<string, TaskFolder>,
  ): void {
    for (const task of tasks) {
      const active =
        task.column === "in_progress" ||
        task.schedule?.state === "launching" ||
        task.schedule?.state === "running";
      if (active && foldersById.get(task.folderId)?.branch) {
        this.busyBranchFolders.add(`${projectId}:${task.folderId}`);
      }
    }
  }

  /**
   * Backlog is inert for the COST pipeline: no estimate, no execution here. This
   * runs the two things that ARE allowed in backlog — self-healing cleanup of
   * stray cost state, and the cheap light analysis (title + tidied prompt) —
   * then, for autopilot folders only, hands the card to "Validé".
   */
  private handleBacklogTask(projectId: string, task: KanbanTask, autopilot: boolean): void {
    // Self-heal legacy/dirty data — a backlog card must never carry a cost
    // estimate or an armed schedule (those belong to "Validé" onward). Retro-
    // cleans boards where analysis fired too early (e.g. Maestria).
    if (task.estimate || task.schedule) {
      this.clearBacklogPipelineState(projectId, task.id);
    }
    // Light analysis is cheap and produces NO cost/billing, so it's allowed in
    // backlog. Re-arm it after a daemon restart, since the queue is in-memory.
    if (task.refinement === "pending" && this.taskLightAnalyzer) {
      this.taskLightAnalyzer.refine(projectId, task.id);
    }
    // Autopilot folders auto-validate their backlog (the folder flag is the
    // consent) so the pipeline still always runs through "Validé".
    if (autopilot && task.approval?.state !== "pending") {
      this.autoTransition(projectId, task.id, "validated");
    }
  }

  /**
   * Self-healing cleanup: strip a stray cost estimate / armed schedule off a
   * task that is (back) in backlog. Cost analysis is a "Validé"-only decision,
   * so a backlog card must never show one. Runs once per dirty task (subsequent
   * ticks see it clean and skip), fixing boards analyzed before this gate.
   */
  private clearBacklogPipelineState(projectId: string, taskId: string): void {
    void this.taskBoardService
      .patchTask(projectId, taskId, (task) => {
        if (task.column !== "backlog" || (!task.estimate && !task.schedule)) {
          return task;
        }
        const next = { ...task };
        delete next.estimate;
        delete next.schedule;
        return next;
      })
      .catch((error) => {
        this.logger.warn({ err: error, taskId }, "Backlog pipeline-state cleanup failed");
      });
  }

  /** Fire-and-forget column move driven by the scheduler (never manual). */
  private autoTransition(projectId: string, taskId: string, column: KanbanTask["column"]): void {
    void this.taskBoardService.transitionTask(projectId, taskId, column).catch((error) => {
      this.logger.warn({ err: error, taskId, column }, "Task auto-transition failed");
    });
  }

  /**
   * Estimation sweep: every task in the pipeline ("validated"/"scheduled") gets
   * one cost estimate so cards/timeline show real sizes and packing can plan.
   * Backlog tasks are never swept — analysis only starts once the user validates.
   * One request per task per daemon lifetime — a failed run writes a fallback.
   */
  private maybeSweepEstimate(projectId: string, task: KanbanTask): void {
    if (task.estimate || task.schedule?.state === "pending_estimate") {
      return;
    }
    const key = `${projectId}:${task.id}`;
    if (this.estimateRequested.has(key)) {
      return;
    }
    this.estimateRequested.add(key);
    this.taskEstimator.requestEstimate(projectId, task.id);
  }

  /** Give automatic repair work a second model when Claude's window is full. */
  private async fallbackDeployConflictProvider(
    projectId: string,
    task: KanbanTask,
  ): Promise<KanbanTask> {
    if (!task.tags.includes(PASEO_DEPLOY_CONFLICT_TAG) || task.runConfig?.provider !== "claude") {
      return task;
    }
    try {
      const usage = await this.providerUsageService.listUsage({ forceRefresh: true });
      const claude = usage.providers.find((provider) => provider.providerId === "claude");
      if (!claude || isProviderUsageExhausted(claude)) {
        return await this.switchDeployConflictToCodex(projectId, task);
      }
      return task;
    } catch (error) {
      this.logger.warn(
        { err: error, taskId: task.id },
        "Automatic deploy-task provider fallback failed",
      );
      return task;
    }
  }

  private async switchDeployConflictToCodex(
    projectId: string,
    task: KanbanTask,
  ): Promise<KanbanTask> {
    return await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
      ...current,
      runConfig: {
        ...current.runConfig,
        provider: "codex",
        model: "gpt-5.4",
        mode: "direct",
      },
    }));
  }

  private async recoverRunningDeployConflict(
    projectId: string,
    task: KanbanTask,
  ): Promise<KanbanTask> {
    if (task.column !== "in_progress" || !task.tags.includes(PASEO_DEPLOY_CONFLICT_TAG)) {
      return task;
    }
    // A repair already running on Codex is healthy. Only requeue a task when
    // this tick actually switched it away from Claude; otherwise every tick
    // would detach its visible agent and create a fresh, empty discussion.
    const wasClaude = task.runConfig?.provider === "claude";
    if (!wasClaude) {
      return task;
    }
    const switched = await this.fallbackDeployConflictProvider(projectId, task);
    return switched.runConfig?.provider === "codex"
      ? this.requeueSwitchedDeployConflictTask(projectId, switched)
      : switched;
  }

  /** Re-open a repair task whose Claude agent was already started before quota was known. */
  private async requeueSwitchedDeployConflictTask(
    projectId: string,
    task: KanbanTask,
  ): Promise<KanbanTask> {
    return await this.taskBoardService.patchTask(projectId, task.id, (current) => {
      if (current.column !== "in_progress" || current.runConfig?.provider !== "codex") {
        return current;
      }
      const {
        taskAgentId: _taskAgentId,
        primaryAgentId: _primaryAgentId,
        ...links
      } = current.links;
      return {
        ...current,
        column: "scheduled",
        schedule: { state: "awaiting_slot", attempts: 0 },
        links,
      };
    });
  }

  // Quota packing: runNow always first; then during quiet hours spend the
  // fresh window on the biggest tasks first, during the day lightest first.
  private sortForPacking(candidates: LaunchCandidate[]): LaunchCandidate[] {
    const inQuietHours = isQuietTime(this.now(), this.getQuietHours());
    return candidates.sort((left, right) => {
      if (left.runNow !== right.runNow) {
        return left.runNow ? -1 : 1;
      }
      const leftQuota = left.task.estimate?.quotaPercent ?? 0;
      const rightQuota = right.task.estimate?.quotaPercent ?? 0;
      if (leftQuota !== rightQuota) {
        return inQuietHours ? rightQuota - leftQuota : leftQuota - rightQuota;
      }
      return (
        left.folderOrder - right.folderOrder ||
        left.task.order - right.task.order ||
        left.task.createdAt.localeCompare(right.task.createdAt)
      );
    });
  }

  /**
   * Timing gate. Light tasks may run anytime in "auto" mode; heavy ones (or an
   * explicit "off_peak" preference) wait for the quiet-hours window. Tasks
   * whose estimate lacks a duration (pre-upgrade estimates) count as heavy.
   */
  private isWithinLaunchWindow(task: KanbanTask): boolean {
    const preference = task.schedulePreference ?? "auto";
    if (preference === "asap") {
      return true;
    }
    const inQuietHours = isQuietTime(this.now(), this.getQuietHours());
    if (preference === "off_peak") {
      return inQuietHours;
    }
    const quotaPct = task.estimate?.quotaPercent ?? Number.POSITIVE_INFINITY;
    const minutes = task.estimate?.estimatedMinutes ?? Number.POSITIVE_INFINITY;
    const light = quotaPct < LIGHT_TASK_MAX_QUOTA_PCT && minutes < LIGHT_TASK_MAX_MINUTES;
    return light || inQuietHours;
  }

  /** Records why an awaiting_slot task is held back; patches only on change. */
  private async setWaitingReason(
    candidate: LaunchCandidate,
    reason: "quota" | "quiet_hours" | undefined,
  ): Promise<void> {
    if (candidate.task.schedule?.waitingReason === reason) {
      return;
    }
    await this.taskBoardService
      .patchTask(candidate.projectId, candidate.task.id, (current) => {
        if (current.schedule?.state !== "awaiting_slot") {
          return current;
        }
        const { waitingReason: _dropped, ...schedule } = current.schedule;
        return {
          ...current,
          schedule: reason === undefined ? schedule : { ...schedule, waitingReason: reason },
        };
      })
      .catch((error) => {
        this.logger.warn(
          { err: error, taskId: candidate.task.id },
          "Failed to record task waiting reason",
        );
      });
  }

  private async hasQuotaFor(task: KanbanTask): Promise<boolean> {
    const estimatePct = task.estimate?.quotaPercent;
    if (estimatePct === undefined) {
      return false;
    }
    const providerId = task.runConfig?.provider ?? "claude";
    let remainingPct: number | null = null;
    try {
      const usage = await this.providerUsageService.listUsage();
      const providerUsage = usage.providers.find((provider) => provider.providerId === providerId);
      const window = providerUsage?.windows.find((entry) => entry.id === "five_hour");
      if (window) {
        remainingPct =
          window.remainingPct ??
          (window.usedPct !== null && window.usedPct !== undefined ? 100 - window.usedPct : null);
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Provider usage lookup failed; deferring task launch");
      return false;
    }
    if (remainingPct === null) {
      // No usage signal (e.g. not a subscription account): don't block execution.
      return true;
    }
    const reservedPct = [...this.inFlight.values()].reduce((sum, value) => sum + value, 0);
    return remainingPct - reservedPct >= estimatePct + QUOTA_SAFETY_MARGIN_PCT;
  }

  private async launch(candidate: LaunchCandidate): Promise<void> {
    const { projectId, task } = candidate;
    this.runNowQueue.delete(`${projectId}:${task.id}`);
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
      ...current,
      schedule: {
        state: "launching",
        attempts: current.schedule?.attempts ?? 0,
        // Carry the cancel-requeue counter across the launch so an interrupted
        // task that keeps re-launching eventually exhausts its budget.
        ...(current.schedule?.cancelRequeues
          ? { cancelRequeues: current.schedule.cancelRequeues }
          : {}),
        lastAttemptAt: new Date().toISOString(),
      },
    }));

    try {
      const { provider, planMode, launchMode } = resolveTaskLaunch(task);
      const plan = resolveTaskWorktreePlan({ task, folder: candidate.folder, planMode });
      // The analysis phase already spawned the task's visible agent in its
      // worktree and ran the read-only analysis turn. Execution CONTINUES that
      // same conversation — reuse the agent instead of creating a new one, so
      // the analysis is the task's starting point. Only the legacy path (no
      // analysis agent, e.g. pre-upgrade tasks) creates the agent here.
      let agentId = task.links.taskAgentId ?? null;
      let branch = task.links.branch ?? plan.branch;
      let workspaceId = task.links.workspaceId ?? null;

      if (!agentId) {
        // Legacy path (no analysis agent yet). A branch-folder reuses its shared
        // worktree; otherwise cut a fresh worktree off the project checkout.
        // Plan-mode runs make no changes, so they run in place — no worktree.
        const created = await this.createAgent({
          kind: "mcp",
          provider,
          cwd: plan.kind === "reuse" ? plan.cwd : project.rootPath,
          title: `Tâche : ${task.title}`,
          labels: { [TASK_AGENT_LABEL]: task.id },
          unattended: true,
          promptFailure: "return-error",
          background: true,
          notifyOnFinish: false,
          ...(task.runConfig?.thinkingOptionId
            ? { thinking: task.runConfig.thinkingOptionId }
            : {}),
          mode: launchMode,
          ...(plan.kind === "reuse" ? { workspaceId: plan.workspaceId } : {}),
          ...(plan.kind === "create"
            ? { worktree: { action: "branch-off" as const, branchName: plan.branchName } }
            : {}),
        });
        if (created.initialPromptError) {
          throw created.initialPromptError;
        }
        agentId = created.snapshot.id;
        branch = plan.branch;
        workspaceId = created.snapshot.workspaceId ?? workspaceId;
        if (plan.kind === "create" && plan.recordFolderId && created.snapshot.workspaceId) {
          await this.taskBoardService.setFolderWorkspace(projectId, plan.recordFolderId, {
            branch: plan.branch,
            workspaceId: created.snapshot.workspaceId,
            worktreeCwd: created.snapshot.cwd,
          });
        }
      }

      await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
        ...current,
        column: "in_progress",
        schedule: {
          state: "running",
          attempts: (current.schedule?.attempts ?? 0) + 1,
          ...(current.schedule?.cancelRequeues
            ? { cancelRequeues: current.schedule.cancelRequeues }
            : {}),
          lastAttemptAt: new Date().toISOString(),
        },
        links: {
          ...current.links,
          agentIds: current.links.agentIds.includes(agentId)
            ? current.links.agentIds
            : [...current.links.agentIds, agentId],
          primaryAgentId: agentId,
          taskAgentId: agentId,
          ...(workspaceId ? { workspaceId } : {}),
          ...(branch ? { branch } : {}),
        },
      }));

      // Cerveau recall + injection happen inside runAgent (AgentManager choke
      // point) — same path as interactive prompts, yellow pill included.
      // Re-fold attachments here too: on the legacy path (no analysis agent) the
      // freshly-created agent has never seen them, and re-sending on the common
      // path is harmless (the file blocks are small path references).
      const prompt = withTaskAttachments(
        buildTaskExecutionPrompt({ task, planMode, branch }),
        task,
      );
      const result = await this.agentManager.runAgent(agentId, prompt);
      if (result.canceled) {
        // A cancellation isn't a task failure — it usually means the run was
        // interrupted (daemon restart, manual stop, quiet-hours window closed).
        // Auto-re-queue for the next slot WITHOUT counting it against
        // MAX_ATTEMPTS, so an interrupted task keeps trying instead of burning
        // attempts and getting stuck as "failed". Bounded by MAX_CANCEL_REQUEUES
        // so a run that cancels instantly every time can't loop forever.
        await this.taskBoardService.patchTask(projectId, task.id, (current) => {
          const cancelRequeues = (current.schedule?.cancelRequeues ?? 0) + 1;
          const attempts = Math.max(0, (current.schedule?.attempts ?? 1) - 1);
          const exhausted = cancelRequeues > MAX_CANCEL_REQUEUES;
          return {
            ...current,
            column: "scheduled",
            schedule: {
              state: exhausted ? ("failed" as const) : ("awaiting_slot" as const),
              attempts,
              cancelRequeues,
              lastAttemptAt: new Date().toISOString(),
              ...(exhausted ? { lastError: "Task agent run was canceled too many times" } : {}),
            },
          };
        });
        this.logger.info(
          { taskId: task.id, agentId },
          "Task run canceled; re-queued for next slot",
        );
        return;
      }

      if (planMode) {
        // Plan runs make no changes: the plan sits in the agent conversation and
        // the user picks it up from there. The card stays in "in_progress".
        await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
          ...current,
          schedule: null,
          planReadyAt: new Date().toISOString(),
        }));
        this.logger.info({ taskId: task.id, agentId }, "Task plan ready");
        return;
      }

      await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
        ...current,
        schedule: null,
      }));
      await this.taskBoardService.transitionTask(projectId, task.id, "done");
      this.logger.info(
        { taskId: task.id, agentId, branch },
        "Task executed in an isolated worktree",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskBoardService
        .patchTask(projectId, task.id, (current) => {
          const attempts = current.schedule?.attempts ?? 1;
          return {
            ...current,
            column: "scheduled",
            schedule: {
              state: attempts >= MAX_ATTEMPTS ? ("failed" as const) : ("awaiting_slot" as const),
              attempts,
              lastError: message,
              lastAttemptAt: new Date().toISOString(),
            },
          };
        })
        .catch((patchError) => {
          this.logger.error(
            { err: patchError, taskId: task.id },
            "Failed to record task launch failure",
          );
        });
      throw error;
    }
  }
}
