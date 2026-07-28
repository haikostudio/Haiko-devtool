import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { TaskBoardService } from "./service.js";
import { resolveTaskAgentId } from "./validator.js";

export interface TaskPublisherOptions {
  taskBoardService: TaskBoardService;
  agentManager: Pick<AgentManager, "appendTimelineItem">;
  logger: pino.Logger;
}

/**
 * What happens the moment a card lands in "Terminée": it is QUEUED, not
 * published.
 *
 * Publication used to fire per card, right here. On the shared checkout that
 * raced itself — several builds reading the same files while other agents were
 * still writing them — and produced torn bundles. So a finished card now moves
 * itself into the last column ("À déployer") and waits there. The user presses
 * "Tout déployer" at the bottom of that column and the whole batch goes online in
 * ONE run, which then restarts the daemon (see {@link TaskBatchDeployer}).
 *
 * The card's conversation says so, so nobody is left wondering whether finishing
 * published anything.
 */
export class TaskPublisher {
  private readonly options: TaskPublisherOptions;
  private readonly logger: pino.Logger;

  constructor(options: TaskPublisherOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "task-publisher" });
  }

  /** Moves a freshly finished card into the publication queue and says so. */
  async queueForDeployment(projectId: string, task: KanbanTask): Promise<void> {
    if (task.column === "deployed") {
      return;
    }
    try {
      await this.options.taskBoardService.transitionTask(projectId, task.id, "deployed");
    } catch (error) {
      this.logger.warn(
        { err: error, projectId, taskId: task.id },
        "Failed to queue a finished card",
      );
      return;
    }
    await this.say(
      resolveTaskAgentId(task),
      "📦 **En attente de publication** — cette tâche rejoint la colonne « À déployer ». Elle partira en ligne au prochain « Tout déployer ».",
    );
  }

  /** Posts a note into the card's conversation; never throws. */
  private async say(agentId: string | null, text: string): Promise<void> {
    if (!agentId) {
      return;
    }
    try {
      await this.options.agentManager.appendTimelineItem(agentId, {
        type: "assistant_message",
        text,
      });
    } catch (error) {
      this.logger.debug({ err: error, agentId }, "Queue note not delivered");
    }
  }
}
