import type { Logger } from "pino";

import type { ProviderUsageHistoryStore } from "./history-store.js";
import type { ProviderUsageService } from "./service.js";

/**
 * One reading every quarter hour. Matches the store's throttle, and since the
 * usage service caches for five minutes this costs at most one provider call per
 * tick — a rounding error against what the agents themselves spend.
 */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;

/** Wait a little after boot so the first tick doesn't compete with startup. */
const DEFAULT_START_DELAY_MS = 30_000;

export interface ProviderUsageHistoryRecorderOptions {
  service: ProviderUsageService;
  store: ProviderUsageHistoryStore;
  logger: Logger;
  pollIntervalMs?: number;
  startDelayMs?: number;
}

/**
 * Polls provider usage on a slow loop and appends each reading to the history
 * store, so the quota curve keeps filling in whether or not anyone has a client
 * open. Failures are logged at debug and skipped: a missed point just leaves a
 * slightly coarser curve.
 */
export class ProviderUsageHistoryRecorder {
  private readonly service: ProviderUsageService;
  private readonly store: ProviderUsageHistoryStore;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly startDelayMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProviderUsageHistoryRecorderOptions) {
    this.service = options.service;
    this.store = options.store;
    this.logger = options.logger.child({ module: "provider-usage-history-recorder" });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
  }

  start(): void {
    if (this.timer || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
      this.timer.unref?.();
    }, this.startDelayMs);
    this.startTimer.unref?.();
    this.logger.info(
      { pollIntervalMs: this.pollIntervalMs },
      "Provider usage history recorder armed",
    );
  }

  stop(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests: take one reading now. */
  async tick(): Promise<void> {
    try {
      const usage = await this.service.listUsage();
      // A replayed last-known-good reading is not a new measurement: recording it would
      // draw a flat segment on the curve that never actually happened.
      await this.store.record(usage.providers.filter((provider) => provider.stale !== true));
    } catch (err) {
      this.logger.debug({ err }, "Provider usage history tick failed");
    }
  }
}
