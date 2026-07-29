import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import { resolveTaskAgentId } from "./validator.js";

export interface TaskPublisherOptions {
  agentManager: Pick<AgentManager, "appendTimelineItem">;
  logger: pino.Logger;
}

/**
 * What happens the moment a card lands in "Terminée": it STOPS there and waits.
 *
 * History of this seam: publication once fired per card right here, which raced
 * the shared checkout and produced torn bundles. The fix moved a finished card
 * automatically into the last column ("À déployer") to batch it. But that auto
 * move meant a card never actually rested in "Terminée" — the column stayed
 * empty and the user never saw the finished work stop. So the card now HALTS in
 * "Terminée". Entering "À déployer" is a separate, manual act: the user presses
 * the card's own "Mettre dans À déployer" button (or drags it there). The daemon
 * never queues a card on its own.
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

  /**
   * Announces that a freshly finished card rests in "Terminée" and awaits a
   * manual queue. It does NOT move the card: entering "À déployer" is the user's
   * explicit press, never an automatic hop.
   */
  async announceReady(task: KanbanTask): Promise<void> {
    if (task.column === "deployed") {
      return;
    }
    await this.say(
      resolveTaskAgentId(task),
      "✅ **Terminé** — cette tâche s'arrête ici. Pour la publier, mets-la dans « À déployer » avec le bouton de la carte, puis lance « Tout déployer ».",
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
