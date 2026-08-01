import type pino from "pino";
import type { KanbanTask, TaskGitStep } from "@getpaseo/protocol/tasks/types";
import { TaskBoardServiceError, type TaskBoardService } from "./service.js";
import {
  gitStep,
  readTaskGitFacts,
  type TaskGitExec,
  withTaskGitBranch,
  withTaskGitFacts,
  withTaskGitStep,
} from "./task-git.js";

export interface TaskGitTrackerOptions {
  taskBoardService: Pick<TaskBoardService, "patchTask" | "getBoard">;
  exec: TaskGitExec;
  /** The project's checkout, where the card's branch lives. Null = unknown. */
  resolveRootPath: (projectId: string) => Promise<string | null>;
  /**
   * Hands a prompt to a card's own agent — the actor behind "Reprendre le
   * conflit". Absent (tests, older wirings) makes that action unavailable
   * instead of silently doing nothing else.
   */
  sendPrompt?: (input: { agentId: string; prompt: string }) => Promise<void>;
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

  /**
   * "Rafraîchir": re-read the branch on demand and hand back the updated card.
   * Unlike {@link refresh} this one is answering a user's press, so a card or a
   * project that cannot be found is an error worth surfacing, not a shrug.
   */
  async refreshById(projectId: string, taskId: string): Promise<KanbanTask> {
    const task = await this.requireTask(projectId, taskId);
    await this.refresh(projectId, task);
    return await this.requireTask(projectId, taskId);
  }

  /**
   * "Reprendre le conflit": the card's own agent goes back into its worktree and
   * resolves the conflict on its branch. Its worktree is already sitting on that
   * branch, so it is the one actor that can do this without a checkout dance.
   *
   * The merge step returns to "en cours" — the conflict is being worked on, and
   * only a later publication can call it settled.
   */
  async resumeConflict(projectId: string, taskId: string): Promise<KanbanTask> {
    const task = await this.requireTask(projectId, taskId);
    const branch = task.git?.branch ?? task.links.branch;
    if (!branch) {
      throw new TaskBoardServiceError(
        "git_no_branch",
        `Task ${taskId} has no branch to repair: nothing to resume.`,
      );
    }
    const agentId = task.links.taskAgentId ?? task.links.primaryAgentId;
    if (!agentId || !this.options.sendPrompt) {
      throw new TaskBoardServiceError(
        "git_agent_unavailable",
        `Task ${taskId} has no agent able to resolve the conflict.`,
      );
    }
    await this.options.sendPrompt({ agentId, prompt: buildConflictPrompt(branch) });
    await this.markStep(
      projectId,
      taskId,
      "merge",
      "running",
      "Reprise du conflit confiée à l'agent de la carte.",
    );
    return await this.requireTask(projectId, taskId);
  }

  private async requireTask(projectId: string, taskId: string): Promise<KanbanTask> {
    const board = await this.options.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    return task;
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

/**
 * What the card's agent is asked to do about its conflict. Deliberately narrow:
 * bring the trunk in, resolve, commit, stop. It must not publish — the user
 * decides when anything goes online, and a repair that ships itself would take
 * that decision away.
 */
function buildConflictPrompt(branch: string): string {
  return [
    `La fusion de ta branche \`${branch}\` a échoué : elle entre en conflit avec le travail d'une autre carte.`,
    "Reprends-la dans ton espace de travail, sur cette branche :",
    "1. Récupère le tronc principal du projet et fusionne-le DANS ta branche.",
    "2. Résous les conflits en gardant ton travail ET celui du tronc.",
    "3. Vérifie que le projet compile et que ses vérifications passent.",
    "4. Enregistre le résultat sur ta branche (commit).",
    "Ne publie rien et ne fusionne pas vers le tronc : la publication reste la décision de l'utilisateur.",
    "Quand la branche est propre et fusionnable, dis-le en une phrase.",
  ].join("\n");
}
