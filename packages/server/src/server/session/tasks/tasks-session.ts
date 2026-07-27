import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { TaskBoardServiceError, type TaskBoardService } from "../../tasks/service.js";
import type { TaskEstimator } from "../../tasks/estimator.js";
import type { TaskScheduler } from "../../tasks/scheduler.js";
import type { ConductorAgentService } from "../../tasks/conductor-agent.js";
import type { TaskValidator } from "../../tasks/validator.js";
import type { TaskDeployer } from "../../tasks/deployer.js";

export interface TasksSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface TasksSessionOptions {
  host: TasksSessionHost;
  taskBoardService: TaskBoardService;
  taskEstimator: TaskEstimator | null;
  taskScheduler: TaskScheduler | null;
  conductorService: ConductorAgentService | null;
  taskValidator: TaskValidator | null;
  taskDeployer: TaskDeployer | null;
  logger: pino.Logger;
}

/**
 * A client's tasks.* request surface: board CRUD plus per-project board
 * subscriptions. Subscriptions are torn down on socket close via dispose().
 */
export class TasksSession {
  private readonly host: TasksSessionHost;
  private readonly taskBoardService: TaskBoardService;
  private readonly taskEstimator: TaskEstimator | null;
  private readonly taskScheduler: TaskScheduler | null;
  private readonly conductorService: ConductorAgentService | null;
  private readonly taskValidator: TaskValidator | null;
  private readonly taskDeployer: TaskDeployer | null;
  private readonly logger: pino.Logger;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(options: TasksSessionOptions) {
    this.host = options.host;
    this.taskBoardService = options.taskBoardService;
    this.taskEstimator = options.taskEstimator;
    this.taskScheduler = options.taskScheduler;
    this.conductorService = options.conductorService;
    this.taskValidator = options.taskValidator;
    this.taskDeployer = options.taskDeployer;
    this.logger = options.logger;
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
  }

  private emitRpcError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof TaskBoardServiceError ? error.code : "tasks_request_failed";
    this.logger.error({ err: error, requestType: request.type }, "Tasks request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code,
      },
    });
  }

  async handleBoardGetRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.board.get.request" }>,
  ): Promise<void> {
    try {
      const board = await this.taskBoardService.getBoard(request.projectId);
      this.host.emit({
        type: "tasks.board.get.response",
        payload: { requestId: request.requestId, board, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleBoardSubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.board.subscribe.request" }>,
  ): Promise<void> {
    try {
      const existing = this.subscriptions.get(request.subscriptionId);
      if (existing) {
        existing();
        this.subscriptions.delete(request.subscriptionId);
      }
      const unsubscribe = this.taskBoardService.subscribe(request.projectId, (board) => {
        this.host.emit({
          type: "tasks.board.update",
          payload: {
            subscriptionId: request.subscriptionId,
            projectId: request.projectId,
            board,
          },
        });
      });
      this.subscriptions.set(request.subscriptionId, unsubscribe);
      const board = await this.taskBoardService.getBoard(request.projectId);
      this.host.emit({
        type: "tasks.board.subscribe.response",
        payload: { requestId: request.requestId, board, error: null },
      });
      // Also deliver the current snapshot on the push channel. A client that
      // re-subscribes after a transparent reconnect does not apply the
      // correlated response above (the board hook is not the caller there), so
      // this push is what refreshes its view and surfaces any task created
      // while the socket was down.
      this.host.emit({
        type: "tasks.board.update",
        payload: {
          subscriptionId: request.subscriptionId,
          projectId: request.projectId,
          board,
        },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleBoardUnsubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.board.unsubscribe.request" }>,
  ): Promise<void> {
    const unsubscribe = this.subscriptions.get(request.subscriptionId);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(request.subscriptionId);
    }
    this.host.emit({
      type: "tasks.board.unsubscribe.response",
      payload: { requestId: request.requestId, error: null },
    });
  }

  async handleFolderCreateRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.folder.create.request" }>,
  ): Promise<void> {
    try {
      const folder = await this.taskBoardService.createFolder(
        request.projectId,
        request.name,
        request.color,
        request.autopilot,
        request.branch,
        request.requireValidation,
      );
      this.host.emit({
        type: "tasks.folder.create.response",
        payload: { requestId: request.requestId, folder, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleFolderUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.folder.update.request" }>,
  ): Promise<void> {
    try {
      const folder = await this.taskBoardService.updateFolder(request.projectId, request.folderId, {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.color !== undefined ? { color: request.color } : {}),
        ...(request.requireValidation !== undefined
          ? { requireValidation: request.requireValidation }
          : {}),
        ...(request.autopilot !== undefined ? { autopilot: request.autopilot } : {}),
        ...(request.branch !== undefined ? { branch: request.branch } : {}),
        ...(request.order !== undefined ? { order: request.order } : {}),
      });
      this.host.emit({
        type: "tasks.folder.update.response",
        payload: { requestId: request.requestId, folder, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleFolderDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.folder.delete.request" }>,
  ): Promise<void> {
    try {
      await this.taskBoardService.deleteFolder(request.projectId, request.folderId);
      this.host.emit({
        type: "tasks.folder.delete.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskCreateRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.create.request" }>,
  ): Promise<void> {
    try {
      const task = await this.taskBoardService.createTask(request.projectId, {
        folderId: request.folderId,
        title: request.title,
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
        ...(request.column !== undefined ? { column: request.column } : {}),
        ...(request.runConfig !== undefined ? { runConfig: request.runConfig } : {}),
        ...(request.schedulePreference !== undefined
          ? { schedulePreference: request.schedulePreference }
          : {}),
        ...(request.launch !== undefined ? { launch: request.launch } : {}),
      });
      this.host.emit({
        type: "tasks.task.create.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.update.request" }>,
  ): Promise<void> {
    try {
      const task = await this.taskBoardService.updateTask(request.projectId, request.taskId, {
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.runConfig !== undefined ? { runConfig: request.runConfig } : {}),
        ...(request.schedulePreference !== undefined
          ? { schedulePreference: request.schedulePreference }
          : {}),
        ...(request.billing !== undefined ? { billing: request.billing } : {}),
        ...(request.executionHold !== undefined ? { executionHold: request.executionHold } : {}),
      });
      this.host.emit({
        type: "tasks.task.update.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskMoveRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.move.request" }>,
  ): Promise<void> {
    try {
      const board = await this.taskBoardService.moveTask(request.projectId, {
        taskId: request.taskId,
        column: request.column,
        index: request.index,
        manual: true,
      });
      this.host.emit({
        type: "tasks.task.move.response",
        payload: { requestId: request.requestId, board, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskMarkViewedRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.mark_viewed.request" }>,
  ): Promise<void> {
    try {
      const board = await this.taskBoardService.markTaskViewed(request.projectId, request.taskId);
      this.host.emit({
        type: "tasks.task.mark_viewed.response",
        payload: { requestId: request.requestId, board, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.delete.request" }>,
  ): Promise<void> {
    try {
      await this.taskBoardService.deleteTask(request.projectId, request.taskId);
      this.host.emit({
        type: "tasks.task.delete.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleConductorEnsureRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.conductor.ensure.request" }>,
  ): Promise<void> {
    try {
      if (!this.conductorService) {
        throw new TaskBoardServiceError(
          "conductor_unavailable",
          "Conductor service is not available",
        );
      }
      const { agentId, workspaceId } = await this.conductorService.ensureConductorAgent(
        request.projectId,
        request.provider,
        { reset: request.reset === true },
      );
      this.host.emit({
        type: "tasks.conductor.ensure.response",
        payload: { requestId: request.requestId, agentId, workspaceId, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, "Conductor ensure request failed");
      this.host.emit({
        type: "tasks.conductor.ensure.response",
        payload: { requestId: request.requestId, agentId: null, workspaceId: null, error: message },
      });
    }
  }

  async handleTaskEstimateRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.estimate.request" }>,
  ): Promise<void> {
    try {
      if (!this.taskEstimator) {
        throw new TaskBoardServiceError("estimator_unavailable", "Task estimator is not available");
      }
      // Manual "relancer l'analyse": drop the prior estimate and re-arm so the
      // analysis re-runs (the estimator reuses the same agent/conversation via
      // links.taskAgentId). The automatic sweep skips already-estimated tasks;
      // this explicit request forces a fresh pass.
      await this.taskBoardService.patchTask(request.projectId, request.taskId, (current) => ({
        ...current,
        estimate: null,
        ...(current.schedule
          ? { schedule: { ...current.schedule, state: "pending_estimate" as const } }
          : {}),
      }));
      this.taskEstimator.requestEstimate(request.projectId, request.taskId);
      this.host.emit({
        type: "tasks.task.estimate.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskApproveRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.approve.request" }>,
  ): Promise<void> {
    try {
      const task = await this.taskBoardService.approveTask(request.projectId, request.taskId);
      this.host.emit({
        type: "tasks.task.approve.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  /**
   * "Archiver": hide a finished (done/deployed) card from the board. Stamps
   * archivedAt; never moves or publishes the card (see docs/task-board-cycle.md).
   */
  async handleTaskArchiveRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.archive.request" }>,
  ): Promise<void> {
    try {
      const task = await this.taskBoardService.archiveTask(
        request.projectId,
        request.taskId,
        request.archived !== false,
      );
      this.host.emit({
        type: "tasks.task.archive.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  /**
   * "Lancer le contrôle": hand the final check to the task's own agent. The
   * verification, the fixes and the completion all happen in the task's
   * conversation, where the user can read them.
   */
  async handleTaskValidateRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.validate.request" }>,
  ): Promise<void> {
    try {
      if (!this.taskValidator) {
        throw new TaskBoardServiceError("validator_unavailable", "Task validator is not available");
      }
      const { task, passed, dispatched } = await this.taskValidator.validate(
        request.projectId,
        request.taskId,
      );
      this.host.emit({
        type: "tasks.task.validate.response",
        payload: { requestId: request.requestId, task, passed, dispatched, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, taskId: request.taskId }, "Task validation request failed");
      this.host.emit({
        type: "tasks.task.validate.response",
        payload: { requestId: request.requestId, task: null, passed: false, error: message },
      });
    }
  }

  /**
   * "Lancer le déploiement": hand a deploy-then-confirm prompt to a finished
   * card's own agent. The agent verifies, deploys, then moves the card to
   * "Déployée" and reports whether a daemon restart is needed — all in the card's
   * own conversation.
   */
  async handleTaskDeployRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.deploy.request" }>,
  ): Promise<void> {
    try {
      if (!this.taskDeployer) {
        throw new TaskBoardServiceError("deployer_unavailable", "Task deployer is not available");
      }
      const { task, dispatched, needsDaemonRestart } = await this.taskDeployer.deploy(
        request.projectId,
        request.taskId,
      );
      this.host.emit({
        type: "tasks.task.deploy.response",
        payload: {
          requestId: request.requestId,
          task,
          dispatched,
          needsDaemonRestart,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, taskId: request.taskId }, "Task deploy request failed");
      this.host.emit({
        type: "tasks.task.deploy.response",
        payload: { requestId: request.requestId, task: null, error: message },
      });
    }
  }

  /**
   * "Analyser à nouveau" on a card whose analysis failed. Clears the failure and
   * its attempt counter, then queues a fresh analysis — the only way out once the
   * automatic retries are spent.
   */
  async handleTaskRetryAnalysisRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.retry_analysis.request" }>,
  ): Promise<void> {
    try {
      if (!this.taskEstimator) {
        throw new TaskBoardServiceError("estimator_unavailable", "Task estimator is not available");
      }
      await this.taskEstimator.retry(request.projectId, request.taskId);
      this.host.emit({
        type: "tasks.task.retry_analysis.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleTaskRunNowRequest(
    request: Extract<SessionInboundMessage, { type: "tasks.task.run_now.request" }>,
  ): Promise<void> {
    try {
      if (!this.taskScheduler) {
        throw new TaskBoardServiceError("scheduler_unavailable", "Task scheduler is not available");
      }
      await this.taskScheduler.runNow(request.projectId, request.taskId);
      this.host.emit({
        type: "tasks.task.run_now.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }
}
