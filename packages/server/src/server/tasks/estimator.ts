import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { TaskBoardService } from "./service.js";
import type { TaskAgentProvisioner } from "./agent-provisioner.js";
import {
  buildTaskAnalysisPrompt,
  parseTaskAnalysisEstimate,
  resolveTaskLaunch,
  withBillingDefaults,
  withTaskAttachments,
  type TaskAnalysisEstimate,
} from "./agent-launch.js";

interface TaskEstimatorOptions {
  agentManager: Pick<AgentManager, "runAgent">;
  agentProvisioner: TaskAgentProvisioner;
  taskBoardService: TaskBoardService;
  projectRegistry: ProjectRegistry;
  logger: pino.Logger;
  /**
   * How many task analyses may run at once. Bounded on purpose: each analysis of
   * a fresh folder cuts a worktree, and a saturated disk makes tasks fail
   * silently (see the VPS disk gotcha). Defaults to {@link DEFAULT_MAX_CONCURRENT}.
   */
  maxConcurrent?: number;
}

const DEFAULT_MAX_CONCURRENT = 4;

// Automatic retries before a failed analysis stops and waits for the user. Low
// on purpose: an analysis that fails three times is a real problem (no disk, no
// quota, a broken checkout), not a hiccup, and looping on it burns quota.
const MAX_ANALYSIS_ATTEMPTS = 3;

/**
 * Analysis phase of the task pipeline. When a task enters "Validé"/"Planifié",
 * this spawns the task's real, VISIBLE agent (the same one that will execute it)
 * in its own worktree, links it to the task immediately so it shows up in the
 * task chat, and runs a read-only analysis turn. The agent streams a readable
 * assessment into the conversation and ends with a structured estimate, which
 * lands on the task (advancing pending_estimate → awaiting_slot). The agent is
 * left alive: the scheduler reuses it for execution — same conversation, so the
 * analysis is the starting point and execution simply continues it.
 *
 * Analyses run in PARALLEL — one agent per task — up to {@link maxConcurrent},
 * so validating a batch no longer waits one-at-a-time. The single exception is
 * tasks of the same branch-folder: they share one worktree (the first task cuts
 * it, the rest reuse it), so they're serialized among themselves to avoid a
 * double-create race. Tasks in different folders (and folderless/legacy tasks,
 * each with their own branch) analyze concurrently.
 */
export class TaskEstimator {
  private readonly agentManager: Pick<AgentManager, "runAgent">;
  private readonly agentProvisioner: TaskAgentProvisioner;
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: pino.Logger;
  private readonly maxConcurrent: number;
  // Pending analyses, each tagged with its serialization group (a branch-folder
  // key when the task shares a folder's worktree, otherwise a task-unique key).
  private readonly queue: { projectId: string; taskId: string; groupKey: string }[] = [];
  // Dedup set (`projectId:taskId`) covering both queued and enqueue-in-flight
  // requests, so a repeated validation doesn't double-analyze a task.
  private readonly queued = new Set<string>();
  // Groups with an analysis currently running; a group holds at most one slot.
  private readonly activeGroups = new Set<string>();
  private activeCount = 0;

  constructor(options: TaskEstimatorOptions) {
    this.agentManager = options.agentManager;
    this.agentProvisioner = options.agentProvisioner;
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "task-estimator" });
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  requestEstimate(projectId: string, taskId: string): void {
    const key = `${projectId}:${taskId}`;
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    void this.enqueue(projectId, taskId);
  }

  private async enqueue(projectId: string, taskId: string): Promise<void> {
    // Resolving the group needs the board (folder lookup); do it before queuing
    // so the scheduling loop below stays synchronous and race-free.
    const groupKey = await this.resolveGroupKey(projectId, taskId);
    this.queue.push({ projectId, taskId, groupKey });
    this.pump();
  }

  /**
   * A branch-folder's tasks share one worktree, so they serialize under the
   * folder key. Everything else — folderless/legacy tasks, plan-mode, or a
   * lookup failure — gets a task-unique key so it analyzes fully in parallel.
   */
  private async resolveGroupKey(projectId: string, taskId: string): Promise<string> {
    try {
      const board = await this.taskBoardService.getBoard(projectId);
      const task = board.tasks.find((entry) => entry.id === taskId);
      const folder = task?.folderId
        ? board.folders.find((entry) => entry.id === task.folderId)
        : undefined;
      if (folder?.branch) {
        return `${projectId}:folder:${folder.id}`;
      }
    } catch (error) {
      this.logger.warn({ err: error, projectId, taskId }, "Failed to resolve analysis group");
    }
    return `${projectId}:task:${taskId}`;
  }

  /**
   * Fills free concurrency slots. Synchronous and re-entrant-safe: it claims the
   * first queued item whose group isn't already running, launches it, and stops
   * when it hits the concurrency cap or every remaining item is group-blocked.
   */
  private pump(): void {
    while (this.activeCount < this.maxConcurrent) {
      const index = this.queue.findIndex((item) => !this.activeGroups.has(item.groupKey));
      if (index === -1) {
        break;
      }
      const [item] = this.queue.splice(index, 1);
      if (!item) {
        break;
      }
      this.queued.delete(`${item.projectId}:${item.taskId}`);
      this.activeGroups.add(item.groupKey);
      this.activeCount += 1;
      void this.runOne(item);
    }
  }

  private async runOne(item: {
    projectId: string;
    taskId: string;
    groupKey: string;
  }): Promise<void> {
    try {
      await this.estimate(item.projectId, item.taskId);
    } catch (error) {
      this.logger.warn(
        { err: error, projectId: item.projectId, taskId: item.taskId },
        "Task analysis failed",
      );
    } finally {
      this.activeGroups.delete(item.groupKey);
      this.activeCount -= 1;
      this.pump();
    }
  }

  private async estimate(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }
    // Done is terminal, and a task already analyzed keeps its estimate + agent.
    if (task.completedAt != null || task.column === "done" || task.estimate) {
      return;
    }
    // A card whose automatic retries are spent waits for the user to ask again
    // (see recordFailure) instead of re-running on every sweep.
    if (task.analysis?.exhausted === true) {
      return;
    }
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      this.logger.warn({ projectId, taskId }, "Cannot analyze task: project not found");
      return;
    }

    let estimate: TaskAnalysisEstimate;
    try {
      estimate = await this.analyze(projectId, task);
    } catch (error) {
      await this.recordFailure(projectId, taskId, error);
      return;
    }

    await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      const next = { ...current };
      // A previous failure is history now.
      delete next.analysis;
      return {
        ...next,
        estimate: {
          // Backfill the Facturation fields from the task so the tab is never
          // blank, even if the agent omitted some of them.
          ...withBillingDefaults(estimate, current),
          model: resolveTaskLaunch(current).provider,
          estimatedAt: new Date().toISOString(),
        },
        ...(current.schedule?.state === "pending_estimate"
          ? { schedule: { ...current.schedule, state: "awaiting_slot" as const } }
          : {}),
      };
    });
  }

  /**
   * A failed analysis writes a FAILURE, never a placeholder estimate.
   *
   * The old behaviour stamped {@link ANALYSIS_FALLBACK_ESTIMATE} on the card so
   * the pipeline could keep moving. It also made the card unrepairable: this
   * method returns early on any task that already has an estimate, so the very
   * act of papering over the crash locked the card out of ever being analyzed
   * again — with an invented cost and invented billing hours on it. The card now
   * says it failed, retries a bounded number of times on its own, and then waits
   * for the user.
   */
  private async recordFailure(projectId: string, taskId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn({ err: error, projectId, taskId }, "Task analysis failed");
    await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      const attempts = (current.analysis?.attempts ?? 0) + 1;
      const exhausted = attempts >= MAX_ANALYSIS_ATTEMPTS;
      return {
        ...current,
        analysis: {
          state: "failed" as const,
          attempts,
          reason,
          failedAt: new Date().toISOString(),
          ...(exhausted ? { exhausted: true } : {}),
        },
      };
    });
  }

  /**
   * User-initiated "analyser à nouveau": wipes the failure (and its attempt
   * counter) so the sweep picks the card up again from scratch.
   */
  async retry(projectId: string, taskId: string): Promise<void> {
    await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      const next = { ...current };
      delete next.analysis;
      return next;
    });
    this.requestEstimate(projectId, taskId);
  }

  /**
   * Ensures the task's visible agent exists (creating it + its worktree and
   * linking it on first analysis), then runs the read-only analysis turn and
   * returns the parsed estimate (or the fallback when none is parseable).
   */
  private async analyze(projectId: string, task: KanbanTask): Promise<TaskAnalysisEstimate> {
    const { planMode } = resolveTaskLaunch(task);
    // The card already owns an agent (attached at creation); this only creates
    // one for legacy cards born before that rule.
    const provisioned = await this.agentProvisioner.ensure(projectId, task.id);
    if (!provisioned) {
      throw new Error(`Cannot analyze task ${task.id}: no agent could be attached`);
    }
    const { agentId } = provisioned;
    const branch = provisioned.branch ?? task.links.branch ?? null;

    const prompt = withTaskAttachments(buildTaskAnalysisPrompt({ task, planMode, branch }), task);
    const run = await this.agentManager.runAgent(agentId, prompt);
    const text = resolveFinalText(run.timeline, run.finalText);
    const estimate = parseTaskAnalysisEstimate(text);
    if (!estimate) {
      // The agent ran but produced no readable estimate. Treat it as a failure
      // (retriable) rather than inventing one: a made-up cost drives the quota
      // gate, the scheduling window AND the Facturation tab, so a wrong number
      // is worse than no number.
      throw new Error("L'agent n'a pas produit d'estimation lisible.");
    }
    return estimate;
  }
}

function resolveFinalText(timeline: AgentTimelineItem[], finalText: string): string {
  if (finalText.trim()) {
    return finalText;
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.type === "assistant_message" && item.text.trim()) {
      return item.text;
    }
  }
  return "";
}
