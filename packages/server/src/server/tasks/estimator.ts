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
}

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
 * Requests are processed one at a time so validating a batch of tasks doesn't
 * spawn a dozen worktrees/agents at once.
 */
export class TaskEstimator {
  private readonly agentManager: Pick<AgentManager, "runAgent">;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: pino.Logger;
  private readonly queue: { projectId: string; taskId: string }[] = [];
  private readonly queued = new Set<string>();
  private processing = false;

  constructor(options: TaskEstimatorOptions) {
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "task-estimator" });
  }

  requestEstimate(projectId: string, taskId: string): void {
    const key = `${projectId}:${taskId}`;
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    this.queue.push({ projectId, taskId });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) {
          break;
        }
        this.queued.delete(`${next.projectId}:${next.taskId}`);
        try {
          await this.estimate(next.projectId, next.taskId);
        } catch (error) {
          this.logger.warn(
            { err: error, projectId: next.projectId, taskId: next.taskId },
            "Task analysis failed",
          );
        }
      }
    } finally {
      this.processing = false;
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
