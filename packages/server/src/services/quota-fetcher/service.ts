import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import {
  friendlyProviderErrorMessage,
  ProviderRateLimitError,
  RATE_LIMITED_PROVIDER_MESSAGE,
  unavailableUsage,
} from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  minRefreshIntervalMs?: number;
  staleMaxAgeMs?: number;
  rateLimitCooldownMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

/** A provider is unusable when any reported quota window is fully consumed. */
export function isProviderUsageExhausted(provider: ProviderUsage): boolean {
  if (provider.status !== "available") {
    return true;
  }
  return provider.windows.some((window) => {
    const remaining =
      window.remainingPct ??
      (window.usedPct !== null && window.usedPct !== undefined ? 100 - window.usedPct : null);
    return remaining !== null && remaining !== undefined && remaining <= 0;
  });
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Floor under `forceRefresh`. The daemon is the single caller of the provider APIs for
 * every connected client, but its own internals force a refresh on their own schedules
 * (the task scheduler ticks every 30s, publication hooks fire in bursts). Without a floor
 * those add up to the request rate that earns a 429 — which then shows on every client.
 */
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000;

/** How long a last-known-good reading is still worth showing once refreshes fail. */
const DEFAULT_STALE_MAX_AGE_MS = 60 * 60 * 1000;

/** Silence for a rate-limited provider when it didn't say how long to wait. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

interface CachedProviderUsage {
  usage: ProviderUsage;
  fetchedAtMs: number;
}

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly staleMaxAgeMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  /** Last reading that actually succeeded, per provider, replayed when a refresh fails. */
  private readonly lastGood = new Map<string, CachedProviderUsage>();
  /** Providers we owe quiet time after a 429; skipped entirely until it elapses. */
  private readonly cooldownUntilMs = new Map<string, number>();

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
    this.staleMaxAgeMs = options.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    // A forced refresh still can't go under the floor: it shortens the cache, it doesn't
    // remove it. Everything else waits out the full TTL.
    const maxAgeMs = options?.forceRefresh ? this.minRefreshIntervalMs : this.cacheTtlMs;
    if (this.cached && nowMs - this.cached.fetchedAtMs < maxAgeMs) {
      return this.cached.result;
    }

    // Concurrent callers — several clients, or a client and a scheduler tick — share the
    // one network round trip rather than each starting their own.
    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const providers = await Promise.all(
      this.fetchers.map((fetcher) => this.resolveProviderUsage(fetcher, nowMs)),
    );
    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }

  /** One provider's reading: fresh when it can be, last-known-good when it can't. */
  private async resolveProviderUsage(
    fetcher: ProviderUsageFetcher,
    nowMs: number,
  ): Promise<ProviderUsage> {
    const cooldownUntilMs = this.cooldownUntilMs.get(fetcher.providerId);
    if (cooldownUntilMs !== undefined && cooldownUntilMs > nowMs) {
      // Calling again during the quiet time is what turns one 429 into a stream of them.
      return this.degradedUsage(fetcher, nowMs, RATE_LIMITED_PROVIDER_MESSAGE);
    }

    try {
      const usage = await fetcher.fetchUsage();
      if (usage.status === "available") {
        this.lastGood.set(fetcher.providerId, { usage, fetchedAtMs: nowMs });
        this.cooldownUntilMs.delete(fetcher.providerId);
        return usage;
      }
      if (usage.status === "error") {
        // A provider that reports its own failure gets the same treatment as a throw:
        // whatever technical text it carries never reaches a card.
        this.logger.debug(
          { providerId: fetcher.providerId, error: usage.error },
          "Provider usage fetch reported an error",
        );
        return this.degradedUsage(fetcher, nowMs, friendlyProviderErrorMessage(usage.error));
      }
      // "unavailable" is a real answer — the provider simply isn't configured here.
      return usage;
    } catch (error) {
      if (error instanceof ProviderRateLimitError) {
        this.cooldownUntilMs.set(
          fetcher.providerId,
          nowMs + (error.retryAfterMs ?? this.rateLimitCooldownMs),
        );
      }
      this.logger.debug(
        { err: error, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return this.degradedUsage(fetcher, nowMs, friendlyProviderErrorMessage(error));
    }
  }

  /**
   * What to show when a refresh didn't land: the last reading that did, flagged stale and
   * dated, for as long as it is still meaningful. Only once there is nothing recent enough
   * left does the card fall back to a plain-language "unavailable".
   */
  private degradedUsage(
    fetcher: ProviderUsageFetcher,
    nowMs: number,
    message: string,
  ): ProviderUsage {
    const good = this.lastGood.get(fetcher.providerId);
    if (good && nowMs - good.fetchedAtMs <= this.staleMaxAgeMs) {
      return {
        ...good.usage,
        stale: true,
        fetchedAt: new Date(good.fetchedAtMs).toISOString(),
        error: null,
      };
    }
    return unavailableUsage({
      providerId: fetcher.providerId,
      displayName: fetcher.displayName,
      error: message,
    });
  }
}
