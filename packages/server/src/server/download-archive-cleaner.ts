import type { Logger } from "pino";
import type { DownloadArchiveStore } from "./file-download/archive-store.js";

/**
 * Periodically reaps expired conductor download archives (see
 * `file-download/archive-store.ts`). Follows the daemon's timer-service shape
 * (mirrors `quota-reset-watcher.ts`): `start()` sweeps once immediately — so
 * stale archives left by a previous run are cleared at boot even if the daemon
 * restarts before the first tick — then installs an unref'd interval.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface DownloadArchiveCleanerOptions {
  archiveStore: DownloadArchiveStore;
  logger: Logger;
  sweepIntervalMs?: number;
}

export class DownloadArchiveCleaner {
  private readonly archiveStore: DownloadArchiveStore;
  private readonly logger: Logger;
  private readonly sweepIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DownloadArchiveCleanerOptions) {
    this.archiveStore = options.archiveStore;
    this.logger = options.logger.child({ module: "download-archive-cleaner" });
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    // Boot guard: reap anything already expired before the first interval fires.
    void this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests: run a single sweep. */
  async sweep(): Promise<void> {
    try {
      const removed = await this.archiveStore.sweepExpired();
      if (removed > 0) {
        this.logger.info({ removed }, "Swept expired download archives");
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to sweep download archives");
    }
  }
}
