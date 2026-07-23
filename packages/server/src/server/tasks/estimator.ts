import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { TaskBoardService } from "./service.js";
import type { TaskFolder } from "@getpaseo/protocol/tasks/types";
import {
  ANALYSIS_FALLBACK_ESTIMATE,
  buildTaskAnalysisPrompt,
  parseTaskAnalysisEstimate,
  resolveTaskLaunch,
  resolveTaskWorktreePlan,
  TASK_AGENT_LABEL,
  type TaskAnalysisEstimate,
} from "./agent-launch.js";

interface TaskEstimatorOptions {
  agentManager: Pick<AgentManager, "runAgent">;
  createAgent: BoundCreateAgentCommand;
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
  private readonly createAgent: BoundCreateAgentCommand;
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
    this.createAgent = options.createAgent;
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
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      this.logger.warn({ projectId, taskId }, "Cannot analyze task: project not found");
      return;
    }

    const folder = board.folders.find((entry) => entry.id === task.folderId);
    let estimate = ANALYSIS_FALLBACK_ESTIMATE;
    try {
      estimate = await this.analyze(projectId, task, project.rootPath, folder);
    } catch (error) {
      this.logger.warn(
        { err: error, projectId, taskId, title: task.title },
        "Task analysis agent failed, using fallback estimate",
      );
    }

    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      estimate: {
        ...estimate,
        model: resolveTaskLaunch(current).provider,
        estimatedAt: new Date().toISOString(),
      },
      ...(current.schedule?.state === "pending_estimate"
        ? { schedule: { ...current.schedule, state: "awaiting_slot" as const } }
        : {}),
    }));
  }

  /**
   * Ensures the task's visible agent exists (creating it + its worktree and
   * linking it on first analysis), then runs the read-only analysis turn and
   * returns the parsed estimate (or the fallback when none is parseable).
   */
  private async analyze(
    projectId: string,
    task: KanbanTask,
    cwd: string,
    folder: TaskFolder | undefined,
  ): Promise<TaskAnalysisEstimate> {
    const { provider, planMode, launchMode } = resolveTaskLaunch(task);
    const plan = resolveTaskWorktreePlan({ task, folder, planMode });
    let agentId = task.links.taskAgentId ?? null;
    let branch = task.links.branch ?? plan.branch;

    if (!agentId) {
      // A branch-folder reuses its shared worktree (run inside its cwd); the
      // first task of the folder (or a legacy task) cuts a fresh worktree.
      const created = await this.createAgent({
        kind: "mcp",
        provider,
        cwd: plan.kind === "reuse" ? plan.cwd : cwd,
        title: `Tâche : ${task.title}`,
        labels: { [TASK_AGENT_LABEL]: task.id },
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
        ...(task.runConfig?.thinkingOptionId ? { thinking: task.runConfig.thinkingOptionId } : {}),
        mode: launchMode,
        ...(plan.kind === "reuse" ? { workspaceId: plan.workspaceId } : {}),
        ...(plan.kind === "create"
          ? { worktree: { action: "branch-off" as const, branchName: plan.branchName } }
          : {}),
      });
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const newAgentId = created.snapshot.id;
      const workspaceId = created.snapshot.workspaceId ?? null;
      agentId = newAgentId;
      branch = plan.branch;
      // First task of a branch-folder: remember the shared worktree so the
      // folder's other tasks land on the same branch.
      if (plan.kind === "create" && plan.recordFolderId && workspaceId) {
        await this.taskBoardService.setFolderWorkspace(projectId, plan.recordFolderId, {
          branch: plan.branch,
          workspaceId,
          worktreeCwd: created.snapshot.cwd,
        });
      }
      // Link the agent to the task immediately so the task chat mirrors it live
      // as it analyzes — the analysis IS the starting point of the task.
      await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
        ...current,
        links: {
          ...current.links,
          taskAgentId: newAgentId,
          primaryAgentId: newAgentId,
          agentIds: current.links.agentIds.includes(newAgentId)
            ? current.links.agentIds
            : [...current.links.agentIds, newAgentId],
          ...(workspaceId ? { workspaceId } : {}),
          ...(branch ? { branch } : {}),
        },
      }));
    }

    const prompt = buildTaskAnalysisPrompt({ task, planMode, branch });
    const run = await this.agentManager.runAgent(agentId, prompt);
    const text = resolveFinalText(run.timeline, run.finalText);
    return parseTaskAnalysisEstimate(text) ?? ANALYSIS_FALLBACK_ESTIMATE;
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
