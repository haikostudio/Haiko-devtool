import type pino from "pino";
import type { ProjectRegistry } from "../workspace-registry.js";
import { isQuietTime, type QuietHours } from "../quiet-hours.js";
import type { TaskBatchDeployer } from "./batch-deployer.js";
import { selectQueuedDeployTasks } from "./batch-deployer.js";
import type { TaskBoardService } from "./service.js";

/** How often the off-peak window is checked. Coarse on purpose. */
const DEFAULT_TICK_MS = 5 * 60 * 1000;

export interface AutoDeploySettings {
  /** Off by default: turning it on IS the standing authorization to restart. */
  enabled: boolean;
  quietHours: QuietHours;
}

export interface AutoDeployWatcherOptions {
  taskBoardService: Pick<TaskBoardService, "getBoard">;
  taskBatchDeployer: Pick<TaskBatchDeployer, "deployAll">;
  projectRegistry: Pick<ProjectRegistry, "list">;
  getSettings: () => AutoDeploySettings;
  tickMs?: number;
  now?: () => number;
  logger: pino.Logger;
}

/**
 * "Publier automatiquement en heures creuses" — the optional, opt-in twin of the
 * "Tout déployer" button.
 *
 * When the option is on, this checks every few minutes whether the clock is
 * inside the quiet-hours window and, if a project has cards waiting in
 * "À déployer", starts exactly the same batch the button would (which ends by
 * restarting the daemon). Off-peak is the point: the restart lands when nobody
 * is working.
 *
 * It never forces anything. `deployAll` keeps every one of its own refusals — a
 * card still running, a batch already going, nothing left to publish — and each
 * one simply means "not this tick".
 */
export class AutoDeployWatcher {
  private readonly options: AutoDeployWatcherOptions;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly logger: pino.Logger;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: AutoDeployWatcherOptions) {
    this.options = options;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger.child({ module: "task-auto-deploy" });
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.debug({ err: error }, "Off-peak publication tick failed");
      });
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass. Exposed so tests drive it without waiting on a timer. */
  async tick(): Promise<void> {
    const settings = this.options.getSettings();
    if (!settings.enabled || !isQuietTime(this.now(), settings.quietHours)) {
      return;
    }
    const projects = await this.options.projectRegistry.list();
    for (const project of projects) {
      if (project.archivedAt) {
        continue;
      }
      await this.tickProject(project.projectId);
    }
  }

  private async tickProject(projectId: string): Promise<void> {
    let pendingCount = 0;
    try {
      const board = await this.options.taskBoardService.getBoard(projectId);
      // Only cards the user PLACED in "À déployer" arm the off-peak run. The run
      // itself then sweeps every finished card along with them, but the order to
      // publish still comes from a human gesture — a card merely resting in
      // "Terminé" must never wake a publication on its own at 3am.
      pendingCount = selectQueuedDeployTasks(board.tasks).length;
    } catch (error) {
      this.logger.debug({ err: error, projectId }, "Off-peak publication board read failed");
      return;
    }
    if (pendingCount === 0) {
      return;
    }
    try {
      await this.options.taskBatchDeployer.deployAll(projectId, { auto: true });
      this.logger.info({ projectId, pendingCount }, "Off-peak publication started");
    } catch (error) {
      // Every refusal (cards still running, batch already going) is a normal
      // "not now", not an incident: it is retried on the next tick.
      this.logger.debug({ err: error, projectId }, "Off-peak publication skipped");
    }
  }
}
