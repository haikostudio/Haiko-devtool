import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import { DEFAULT_TASKS_QUIET_HOURS, isQuietTime, type QuietHours } from "../quiet-hours.js";
import type { TaskBoardService } from "./service.js";
import type { TaskEstimator } from "./estimator.js";

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
// "Light" tasks (below both thresholds) may launch outside quiet hours in
// "auto" mode; anything heavier waits for the off-peak window.
const LIGHT_TASK_MAX_QUOTA_PCT = 25;
const LIGHT_TASK_MAX_MINUTES = 45;

export const TASK_AGENT_LABEL = "paseo.task-id";

interface TaskSchedulerOptions {
  taskBoardService: TaskBoardService;
  taskEstimator: TaskEstimator;
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
  folderOrder: number;
  runNow: boolean;
}

// Branch (and worktree slug) for a task launch: stable, readable, unique via a
// short task-id suffix so two similarly-titled tasks never collide.
function taskBranchName(task: KanbanTask): string {
  const slug = task.title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+)|(-+$)/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = task.id.slice(0, 6);
  return slug ? `task/${slug}-${suffix}` : `task/${suffix}`;
}

// "Planifié" column task ready to launch: estimated, awaiting a slot, and not
// an unapproved agent proposal.
function isScheduledCandidate(task: KanbanTask): boolean {
  return (
    task.column === "scheduled" &&
    task.schedule?.state === "awaiting_slot" &&
    Boolean(task.estimate) &&
    task.approval?.state !== "pending"
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
    task.schedule?.state !== "running"
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
  // Open tasks already sent to the estimator this daemon lifetime — the sweep
  // estimates each task once (a failed run writes a fallback estimate anyway).
  private readonly estimateRequested = new Set<string>();

  constructor(options: TaskSchedulerOptions) {
    this.taskBoardService = options.taskBoardService;
    this.taskEstimator = options.taskEstimator;
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
    for (const project of projects) {
      if (project.archivedAt) {
        continue;
      }
      const board = await this.taskBoardService.getBoard(project.projectId);
      if (board.tasks.length === 0) {
        continue;
      }
      const folderOrders = new Map(board.folders.map((folder) => [folder.id, folder.order]));
      const folderAutopilot = new Map(
        board.folders.map((folder) => [folder.id, folder.autopilot === true]),
      );
      for (const task of board.tasks) {
        if (task.column === "done" || task.column === "in_progress") {
          continue;
        }
        if (task.column === "backlog") {
          // Backlog tasks are inert: no analysis, no execution until validated.
          // Autopilot folders auto-validate their backlog (the folder flag is the
          // consent) so the pipeline still always runs through "Validé".
          if (folderAutopilot.get(task.folderId) === true && task.approval?.state !== "pending") {
            this.autoTransition(project.projectId, task.id, "validated");
          }
          continue;
        }
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
          folderOrder: folderOrders.get(task.folderId) ?? 0,
          runNow: this.runNowQueue.has(`${project.projectId}:${task.id}`),
        });
      }
    }
    return this.sortForPacking(candidates);
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
        lastAttemptAt: new Date().toISOString(),
      },
    }));

    try {
      const runConfig = task.runConfig;
      const planMode = runConfig?.mode === "plan";
      const providerId = runConfig?.provider ?? "claude";
      let provider = "claude";
      if (runConfig) {
        provider = runConfig.model
          ? `${runConfig.provider}/${runConfig.model}`
          : runConfig.provider;
      }
      // Task agents run unattended, so they must never block on a permission
      // prompt mid-run. Launch them with the maximally-permissive mode for their
      // provider: Claude "bypassPermissions", Codex "full-access". Plan-mode runs
      // make no changes and keep their own mode.
      let launchMode = "bypassPermissions";
      if (planMode) {
        launchMode = "plan";
      } else if (providerId === "codex") {
        launchMode = "full-access";
      }
      // Each launch gets its own worktree + branch off the project checkout, so
      // several task agents can run in the same project concurrently without
      // touching the user's working directory. Plan-mode runs make no changes,
      // so they run directly in the current workspace — no throwaway worktree.
      const branchName = planMode ? null : taskBranchName(task);
      const created = await this.createAgent({
        kind: "mcp",
        provider,
        cwd: project.rootPath,
        title: `Tâche : ${task.title}`,
        labels: { [TASK_AGENT_LABEL]: task.id },
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
        ...(runConfig?.thinkingOptionId ? { thinking: runConfig.thinkingOptionId } : {}),
        mode: launchMode,
        ...(branchName ? { worktree: { action: "branch-off" as const, branchName } } : {}),
      });
      const agent = created.snapshot;
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }

      const branch = branchName;
      await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
        ...current,
        column: "in_progress",
        schedule: {
          state: "running",
          attempts: (current.schedule?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
        links: {
          ...current.links,
          agentIds: current.links.agentIds.includes(agent.id)
            ? current.links.agentIds
            : [...current.links.agentIds, agent.id],
          primaryAgentId: agent.id,
          ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
          ...(branch ? { branch } : {}),
        },
      }));

      // Cerveau recall + injection happen inside runAgent (AgentManager choke
      // point) — same path as interactive prompts, yellow pill included.
      const prompt = this.buildTaskPrompt({ task, planMode, branch });
      const result = await this.agentManager.runAgent(agent.id, prompt);
      if (result.canceled) {
        throw new Error("Task agent run was canceled");
      }

      if (planMode) {
        // Plan runs make no changes: the plan sits in the agent conversation and
        // the user picks it up from there. The card stays in "in_progress".
        await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
          ...current,
          schedule: null,
          planReadyAt: new Date().toISOString(),
        }));
        this.logger.info({ taskId: task.id, agentId: agent.id }, "Task plan ready");
        return;
      }

      await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
        ...current,
        schedule: null,
      }));
      await this.taskBoardService.transitionTask(projectId, task.id, "done");
      this.logger.info(
        { taskId: task.id, agentId: agent.id, branch },
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

  private buildTaskPrompt(input: {
    task: KanbanTask;
    planMode: boolean;
    branch: string | null;
  }): string {
    const { task, planMode, branch } = input;
    const header = [
      planMode
        ? "Tu exécutes une tâche du gestionnaire de tâches Paseo directement dans le workspace en cours du projet."
        : `Tu exécutes une tâche du gestionnaire de tâches Paseo dans un worktree dédié, sur la branche ${branch ?? "de la tâche"}. Le checkout principal de l'utilisateur n'est pas touché.`,
      "",
      `## Tâche`,
      `Titre : ${task.title}`,
      task.description ? `Description :\n${task.description}` : "",
      task.tags.length > 0 ? `Tags : ${task.tags.join(", ")}` : "",
      "",
      "## Instructions",
    ];
    const instructions = planMode
      ? [
          "1. Analyse la tâche et le dépôt, puis produis un PLAN D'IMPLÉMENTATION détaillé et actionnable :",
          "   fichiers à modifier, approche retenue, étapes ordonnées, risques, tests à écrire.",
          "2. NE modifie AUCUN fichier, ne commite pas, ne pousse pas.",
          "3. Termine ta réponse par le plan complet en Markdown — l'utilisateur reprendra",
          "   la main dans cette conversation pour décider de l'exécution.",
        ]
      : [
          "1. Implémente la tâche complètement dans ce dépôt, en respectant ses conventions.",
          "2. Vérifie ton travail (typecheck, lint, tests ciblés pertinents s'ils existent).",
          "3. Commite tes changements sur cette branche avec un message conventionnel clair.",
          "4. NE pousse PAS et NE crée PAS de pull request : l'utilisateur relit la branche et merge lui-même.",
          "5. Termine ta réponse par un résumé de ce que tu as fait et la liste des fichiers modifiés.",
        ];
    return [...header, ...instructions].filter((line) => line !== "").join("\n");
  }
}
