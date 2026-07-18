import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import { DEFAULT_TASKS_QUIET_HOURS, isQuietTime, type QuietHours } from "../quiet-hours.js";
import type { TaskBoardService } from "./service.js";
import type { TaskEstimator } from "./estimator.js";

const execFileAsync = promisify(execFile);

const TICK_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_TASK_AGENTS = 2;
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
  agentManager: Pick<AgentManager, "runAgent">;
  createAgent: BoundCreateAgentCommand;
  providerUsageService: Pick<ProviderUsageService, "listUsage">;
  logger: pino.Logger;
  tickIntervalMs?: number;
  /** Off-peak window for heavy tasks. Defaults to 01:00–07:00 Europe/Paris. */
  getQuietHours?: () => QuietHours;
  /** Reads the current branch of a checkout; injected for tests. */
  readCurrentBranch?: (cwd: string) => Promise<string | null>;
  /** Injected for tests. */
  now?: () => number;
}

interface LaunchCandidate {
  projectId: string;
  task: KanbanTask;
  folderOrder: number;
  runNow: boolean;
}

async function defaultReadCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 15_000,
    });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Executes tasks the user dragged into the "Planifié" column. Consent is
 * structural: only column === "scheduled" tasks are ever considered, so a
 * backlog card can never auto-run. Each launch opens a fresh visible
 * (non-internal) agent directly in the project's current workspace — the same
 * checkout the user works in, no throwaway worktree — instructed to implement
 * the task and commit locally (no push, no PR). Plan-mode tasks produce a plan
 * and stop without touching files.
 *
 * Because these agents share the project's working directory, launches are
 * serialized per project: a project with an in-flight task is skipped until it
 * frees up, so two task agents never fight over the same checkout.
 *
 * The quota gate reads the task provider's five_hour window and only launches
 * when remaining % covers the task estimate plus a safety margin, minus
 * estimates already reserved by in-flight launches.
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
  private readonly agentManager: Pick<AgentManager, "runAgent">;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly providerUsageService: Pick<ProviderUsageService, "listUsage">;
  private readonly logger: pino.Logger;
  private readonly tickIntervalMs: number;
  private readonly readCurrentBranch: (cwd: string) => Promise<string | null>;
  private readonly getQuietHours: () => QuietHours;
  private readonly now: () => number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  // taskId -> reserved quota percent for launches still in flight.
  private readonly inFlight = new Map<string, number>();
  // Projects with an in-flight launch: one task agent per checkout at a time.
  private readonly inFlightProjects = new Set<string>();
  private readonly runNowQueue = new Set<string>();

  constructor(options: TaskSchedulerOptions) {
    this.taskBoardService = options.taskBoardService;
    this.taskEstimator = options.taskEstimator;
    this.projectRegistry = options.projectRegistry;
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.providerUsageService = options.providerUsageService;
    this.logger = options.logger.child({ module: "task-scheduler" });
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.readCurrentBranch = options.readCurrentBranch ?? defaultReadCurrentBranch;
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
        if (this.inFlightProjects.has(candidate.projectId)) {
          // One task agent per checkout: another task for this project is still
          // running in its shared working directory.
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
        this.inFlightProjects.add(candidate.projectId);
        void this.launch(candidate)
          .catch((error) => {
            this.logger.error(
              { err: error, taskId: candidate.task.id, projectId: candidate.projectId },
              "Task launch failed",
            );
          })
          .finally(() => {
            this.inFlight.delete(candidate.task.id);
            this.inFlightProjects.delete(candidate.projectId);
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
      for (const task of board.tasks) {
        if (task.column !== "scheduled" || !task.schedule) {
          continue;
        }
        if (task.schedule.state === "pending_estimate") {
          // Re-arm after daemon restarts: the estimate request queue is in-memory.
          // Also runs for approval-pending proposals so the cost is ready to review.
          this.taskEstimator.requestEstimate(project.projectId, task.id);
          continue;
        }
        if (task.approval?.state === "pending") {
          // Agent proposals never launch without explicit user approval.
          continue;
        }
        if (task.schedule.state !== "awaiting_slot" || !task.estimate) {
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
    candidates.sort((left, right) => {
      if (left.runNow !== right.runNow) {
        return left.runNow ? -1 : 1;
      }
      return (
        left.folderOrder - right.folderOrder ||
        left.task.order - right.task.order ||
        left.task.createdAt.localeCompare(right.task.createdAt)
      );
    });
    return candidates;
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
      let provider = "claude";
      if (runConfig) {
        provider = runConfig.model
          ? `${runConfig.provider}/${runConfig.model}`
          : runConfig.provider;
      }
      // Run in the project's current workspace: passing cwd without a
      // workspaceId reuses the existing workspace for that checkout.
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
        ...(planMode ? { mode: "plan" } : {}),
      });
      const agent = created.snapshot;
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }

      const branch = await this.readCurrentBranch(project.rootPath);
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

      const prompt = this.buildTaskPrompt({ task, planMode });
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
        { taskId: task.id, agentId: agent.id },
        "Task executed in the current workspace",
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

  private buildTaskPrompt(input: { task: KanbanTask; planMode: boolean }): string {
    const { task, planMode } = input;
    const header = [
      "Tu exécutes une tâche du gestionnaire de tâches Paseo directement dans le workspace en cours du projet.",
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
          "3. Commite tes changements avec un message conventionnel clair.",
          "4. NE pousse PAS et NE crée PAS de pull request : l'utilisateur relit et pousse lui-même.",
          "5. Termine ta réponse par un résumé de ce que tu as fait et la liste des fichiers modifiés.",
        ];
    return [...header, ...instructions].filter((line) => line !== "").join("\n");
  }
}
