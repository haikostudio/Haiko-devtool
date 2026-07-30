import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { TaskBoardServiceError, type TaskBoardService } from "./service.js";

export interface TaskValidationOutcome {
  task: KanbanTask;
  /** True when the card is finished — which, since the move is direct, is always. */
  passed: boolean;
  /**
   * Kept for old clients only: nothing is ever handed to an agent any more, so
   * this is always false.
   *
   * COMPAT(taskValidateDispatched): added in v0.1.x, drop the field from the
   * response once no client older than the silent-completion change is around.
   */
  dispatched: boolean;
}

export interface TaskValidatorOptions {
  taskBoardService: TaskBoardService;
  logger: pino.Logger;
}

/**
 * "Terminer la tâche": the move from "En cours" to "Terminé", and NOTHING else.
 *
 * This used to be a "final check": pressing the bar handed the card's own agent a
 * long check-then-deploy prompt (re-read the request, run the project's checks,
 * fix what it found, push the change onto the project's dev instance, then
 * complete the card itself). Two things were wrong with that. It DEPLOYED — a
 * card looked published before the user had queued anything, which is precisely
 * what the "À déployer" column exists to decide. And it burned a full agent turn
 * on every finished card, which is the single most expensive moment of the board.
 *
 * So the step is now inert: the card moves to "Terminé", its status is tidied,
 * and no prompt is sent. Verifying that the work really runs — and fixing it if
 * it does not — belongs to the publication, where the code is about to go online
 * anyway (see buildDeployPrompt in deployer.ts and docs/task-board-cycle.md).
 *
 * Because nothing is dispatched, there is no consent window to open either: an
 * agent can no longer complete a card at all. "En cours" → "Terminé" is the
 * user's press or the user's drag, full stop.
 */
export class TaskValidator {
  private readonly taskBoardService: TaskBoardService;
  private readonly logger: pino.Logger;

  constructor(options: TaskValidatorOptions) {
    this.taskBoardService = options.taskBoardService;
    this.logger = options.logger.child({ module: "task-validator" });
  }

  /**
   * @param queueOnComplete "Terminer et mettre en file": arm the card so that
   * completing it also queues it into "À déployer", instead of stopping in
   * "Terminé" and waiting for a second press. Armed here, honoured (and cleared)
   * by the completion listener, so it can never outlive this run.
   */
  async validate(
    projectId: string,
    taskId: string,
    queueOnComplete = false,
  ): Promise<TaskValidationOutcome> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    // Already finished or already queued: nothing to move.
    if (task.column === "done" || task.column === "deployed") {
      return { task, passed: true, dispatched: false };
    }
    // "En cours" is the only column a card may leave for "Terminé". Without this
    // the bar could finish a card whose work never ran (an old client, or a card
    // dragged back out of "En cours").
    if (task.column !== "in_progress") {
      throw new TaskBoardServiceError(
        "task_validate_not_started",
        "Cette tâche n'est pas encore en cours : lancez-la avant de la terminer.",
      );
    }

    // Arm the queue hop (read by the completion listener) and clear any check
    // state a card may still carry from the days when finishing ran an agent —
    // otherwise a stale "running" window would sit on the card forever.
    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      validation: null,
      queueOnComplete,
    }));
    await this.taskBoardService.transitionTask(projectId, taskId, "done");

    const finished = await this.taskBoardService.getBoard(projectId);
    const moved = finished.tasks.find((entry) => entry.id === taskId) ?? task;
    this.logger.info({ projectId, taskId, queueOnComplete }, "Task moved to done by the user");
    return { task: moved, passed: true, dispatched: false };
  }
}
