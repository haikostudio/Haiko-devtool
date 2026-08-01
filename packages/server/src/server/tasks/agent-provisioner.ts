import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { TaskBoardService } from "./service.js";
import { resolveTaskLaunch, resolveTaskWorktreePlan, TASK_AGENT_LABEL } from "./agent-launch.js";
import { withTaskGitBranch } from "./task-git.js";

export interface ProvisionedTaskAgent {
  agentId: string;
  branch: string | null;
  workspaceId: string | null;
}

interface TaskAgentProvisionerOptions {
  createAgent: BoundCreateAgentCommand;
  taskBoardService: TaskBoardService;
  projectRegistry: ProjectRegistry;
  logger: pino.Logger;
}

/**
 * Owns the one rule that makes a task readable end to end: a card has ONE agent,
 * and it is created the moment the card is born.
 *
 * Everything the task ever does goes through that single conversation — the
 * title tidy-up, the analysis, the execution, the deploy check, and every prompt
 * the interface injects on the user's behalf. That is what lets the user open a
 * card months later, in any column including "deployed", and read the whole
 * story in order instead of a few disconnected fragments.
 *
 * Creation is idempotent and race-safe: concurrent callers (creation, estimator,
 * scheduler) serialize on the same per-task promise, so a card can never end up
 * with two agents fighting over the same worktree.
 */
export class TaskAgentProvisioner {
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: pino.Logger;
  // `projectId:taskId` -> in-flight provisioning. Two callers asking at once get
  // the same agent instead of racing to create two.
  private readonly inFlight = new Map<string, Promise<ProvisionedTaskAgent | null>>();

  constructor(options: TaskAgentProvisionerOptions) {
    this.createAgent = options.createAgent;
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "task-agent-provisioner" });
  }

  /**
   * Returns the task's agent, creating and linking it on first call. Returns
   * null only when the task or project is gone — every other failure throws, so
   * callers can surface a real reason instead of silently proceeding agentless.
   */
  async ensure(projectId: string, taskId: string): Promise<ProvisionedTaskAgent | null> {
    const key = `${projectId}:${taskId}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return await existing;
    }
    const pending = this.provision(projectId, taskId).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return await pending;
  }

  /** Fire-and-forget variant for callers that must not block (task creation). */
  ensureInBackground(projectId: string, taskId: string): void {
    void this.ensure(projectId, taskId).catch((error) => {
      this.logger.warn(
        { err: error, projectId, taskId },
        "Failed to attach the task's agent on creation",
      );
    });
  }

  private async provision(projectId: string, taskId: string): Promise<ProvisionedTaskAgent | null> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return null;
    }
    if (task.links.taskAgentId) {
      return {
        agentId: task.links.taskAgentId,
        branch: task.links.branch ?? null,
        workspaceId: task.links.workspaceId ?? null,
      };
    }
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      this.logger.warn({ projectId, taskId }, "Cannot attach a task agent: project not found");
      return null;
    }
    return await this.create(projectId, task, project.rootPath);
  }

  private async create(
    projectId: string,
    task: KanbanTask,
    projectRoot: string,
  ): Promise<ProvisionedTaskAgent> {
    const { provider, launchMode } = resolveTaskLaunch(task);
    // EVERY card gets its OWN isolated worktree + `task/<id>-<slug>` branch — no
    // exception, not even Paseo itself or plan-mode. Sixty cards of one project
    // run in parallel without fighting over a checkout, so a card can never wait
    // on "une autre tâche occupe le dossier". The worktree is cut here, at
    // creation, so the card's whole life (analysis, execution, deploy check)
    // happens inside it.
    const plan = resolveTaskWorktreePlan({ task });
    const created = await this.createAgent({
      kind: "mcp",
      provider,
      cwd: projectRoot,
      title: `Tâche : ${task.title}`,
      labels: { [TASK_AGENT_LABEL]: task.id },
      unattended: true,
      promptFailure: "return-error",
      background: true,
      notifyOnFinish: false,
      ...(task.runConfig?.thinkingOptionId ? { thinking: task.runConfig.thinkingOptionId } : {}),
      mode: launchMode,
      worktree: { branchName: plan.branch, action: "branch-off" as const },
    });
    if (created.initialPromptError) {
      throw created.initialPromptError;
    }
    const agentId = created.snapshot.id;
    const workspaceId = created.snapshot.workspaceId ?? null;
    // Prefer the branch git actually created (worktree-core re-normalizes the
    // requested name); fall back to the planned name.
    const branch = created.createdWorktree?.worktree.branchName ?? plan.branch;

    // Link immediately so the card's chat binds to this conversation from the
    // very first second, before any prompt is sent into it. The branch is also
    // stamped on the card's git journey right here — its first step exists from
    // the moment the worktree is cut, not once something has been committed.
    const now = new Date().toISOString();
    await this.taskBoardService.patchTask(projectId, task.id, (current) => ({
      ...current,
      ...(branch ? { git: withTaskGitBranch(current.git, branch, now) } : {}),
      links: {
        ...current.links,
        taskAgentId: agentId,
        primaryAgentId: agentId,
        agentIds: current.links.agentIds.includes(agentId)
          ? current.links.agentIds
          : [...current.links.agentIds, agentId],
        ...(workspaceId ? { workspaceId } : {}),
        ...(branch ? { branch } : {}),
      },
    }));

    this.logger.info({ projectId, taskId: task.id, agentId }, "Task agent attached");
    return { agentId, branch, workspaceId };
  }
}
