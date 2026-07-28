import type pino from "pino";
import type { PushHistoryContext, PushPayload } from "../push/notifications.js";

const DEBOUNCE_MS = 5_000;

interface PendingBatch {
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

interface TaskProposalNotifierOptions {
  serverId: string;
  getProjectName: (projectId: string) => Promise<string | null>;
  sendPush: (payload: PushPayload, context?: PushHistoryContext) => void;
  logger: pino.Logger;
  debounceMs?: number;
}

/**
 * Turns bursts of agent-proposed tasks into a single push notification per
 * project ("3 tâches proposées — à confirmer"). Agents typically create several
 * tasks in one turn, so proposals are debounced and aggregated per project.
 */
export class TaskProposalNotifier {
  private readonly serverId: string;
  private readonly getProjectName: (projectId: string) => Promise<string | null>;
  private readonly sendPush: (payload: PushPayload, context?: PushHistoryContext) => void;
  private readonly logger: pino.Logger;
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingBatch>();

  constructor(options: TaskProposalNotifierOptions) {
    this.serverId = options.serverId;
    this.getProjectName = options.getProjectName;
    this.sendPush = options.sendPush;
    this.logger = options.logger.child({ module: "task-proposal-notifier" });
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  notifyProposed(projectId: string): void {
    const existing = this.pending.get(projectId);
    if (existing) {
      existing.count += 1;
      return;
    }
    const timer = setTimeout(() => {
      const batch = this.pending.get(projectId);
      this.pending.delete(projectId);
      if (batch) {
        void this.flush(projectId, batch.count).catch((error) => {
          this.logger.warn({ err: error, projectId }, "Task proposal push failed");
        });
      }
    }, this.debounceMs);
    // Don't keep the daemon alive just for a pending notification.
    timer.unref?.();
    this.pending.set(projectId, { count: 1, timer });
  }

  stop(): void {
    for (const batch of this.pending.values()) {
      clearTimeout(batch.timer);
    }
    this.pending.clear();
  }

  private async flush(projectId: string, count: number): Promise<void> {
    const projectName = (await this.getProjectName(projectId)) ?? projectId;
    const title = count === 1 ? "Tâche proposée" : "Tâches proposées";
    const body =
      count === 1
        ? `1 tâche proposée dans ${projectName} — à confirmer`
        : `${count} tâches proposées dans ${projectName} — à confirmer`;
    this.sendPush(
      {
        title,
        body,
        data: {
          serverId: this.serverId,
          projectId,
          kind: "tasks_proposal",
        },
      },
      // The history row groups by project like every other notification.
      { projectName, summary: body },
    );
  }
}
