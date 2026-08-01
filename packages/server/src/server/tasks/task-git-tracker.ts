import type pino from "pino";
import type { KanbanTask, TaskGitStep } from "@getpaseo/protocol/tasks/types";
import type { TaskBoardService } from "./service.js";
import {
  gitStep,
  readTaskGitFacts,
  type TaskGitExec,
  withTaskGitBranch,
  withTaskGitFacts,
  withTaskGitStep,
} from "./task-git.js";

export interface TaskGitTrackerOptions {
  taskBoardService: Pick<TaskBoardService, "patchTask">;
  exec: TaskGitExec;
  /** The project's checkout, where the card's branch lives. Null = unknown. */
  resolveRootPath: (projectId: string) => Promise<string | null>;
  logger: pino.Logger;
}

/**
 * Keeps each card's git journey up to date on the BOARD.
 *
 * Every write goes through here rather than being scattered over the scheduler,
 * the deployer and the estimator: those all know one step each, and a card that
 * only ever hears from one of them tells half a story. Nothing here throws — a
 * git read that fails leaves the card saying "en attente", which is true, and
 * never turns a working publication into a red step.
 */
export class TaskGitTracker {
  private readonly options: TaskGitTrackerOptions;
  private readonly logger: pino.Logger;

  constructor(options: TaskGitTrackerOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "task-git-tracker" });
  }

  /** Stamps the dedicated branch, the moment the isolated worktree is cut. */
  async recordBranch(projectId: string, taskId: string, branch: string): Promise<void> {
    await this.patch(projectId, taskId, (task, now) => ({
      ...task,
      git: withTaskGitBranch(task.git, branch, now),
    }));
  }

  /**
   * Re-reads the branch tip and whether it left the machine. Called when a run
   * ends and before a publication, so the commit shown on the card is the one
   * that is actually there — not the one that existed when it was last looked at.
   */
  async refresh(projectId: string, task: KanbanTask): Promise<void> {
    const branch = task.git?.branch ?? task.links.branch;
    if (!branch) {
      return;
    }
    const rootPath = await this.rootPath(projectId);
    if (!rootPath) {
      return;
    }
    try {
      const facts = await readTaskGitFacts({ exec: this.options.exec, cwd: rootPath, branch });
      await this.patch(projectId, task.id, (current, now) => ({
        ...current,
        git: withTaskGitFacts(withTaskGitBranch(current.git, branch, now), facts, now),
      }));
    } catch (error) {
      this.logger.debug({ err: error, projectId, taskId: task.id }, "Git facts read failed");
    }
  }

  /** Records one step's outcome (push, merge or publication) on the card. */
  async markStep(
    projectId: string,
    taskId: string,
    step: "push" | "merge" | "publish",
    state: TaskGitStep["state"],
    detail?: string | null,
  ): Promise<void> {
    await this.patch(projectId, taskId, (task, now) => ({
      ...task,
      git: withTaskGitStep(task.git, step, gitStep(state, now, detail), now),
    }));
  }

  private async rootPath(projectId: string): Promise<string | null> {
    try {
      return await this.options.resolveRootPath(projectId);
    } catch (error) {
      this.logger.debug({ err: error, projectId }, "Project checkout could not be resolved");
      return null;
    }
  }

  private async patch(
    projectId: string,
    taskId: string,
    change: (task: KanbanTask, now: string) => KanbanTask,
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.options.taskBoardService.patchTask(projectId, taskId, (task) => change(task, now));
    } catch (error) {
      this.logger.debug({ err: error, projectId, taskId }, "Git journey patch failed");
    }
  }
}
