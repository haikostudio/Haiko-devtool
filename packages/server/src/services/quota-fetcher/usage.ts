import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageTone,
  ProviderUsageWindow,
} from "../../server/messages.js";
import type { ProviderApiFetch } from "./provider.js";

const PROVIDER_HTTP_TIMEOUT_MS = 15_000;

/**
 * Inline retry budget for a 429. Deliberately small: every provider refreshes in the same
 * batch and a client is waiting on the whole batch, so holding the request open for a long
 * `Retry-After` would trade one bad card for a hung panel. Anything longer than the inline
 * cap is handed to the service, which puts the provider on a cooldown and replays the last
 * known good reading instead.
 */
const RATE_LIMIT_RETRY_ATTEMPTS = 2;
const RATE_LIMIT_BASE_DELAY_MS = 500;
const RATE_LIMIT_MAX_INLINE_DELAY_MS = 4_000;

export const ApiNumberSchema = z.coerce.number().finite();
export const ApiNullableNumberSchema = z.preprocess(
  (value) => (value == null ? null : value),
  ApiNumberSchema.nullable(),
);
export const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

/** A provider answered 429. Carries how long it asked us to wait, when it said so. */
export class ProviderRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number | null) {
    super("Provider usage API is rate limiting requests");
    this.name = "ProviderRateLimitError";
  }
}

export interface ProviderApiRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxInlineDelayMs?: number;
  /** Injected by tests so a 429 path doesn't have to spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `Retry-After` in either legal form: delta-seconds, or an HTTP date. */
export function retryAfterMsFrom(headers: Headers, nowMs: number = Date.now()): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1000 : 0;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * One provider HTTP call, with the 429 handling every provider needs.
 *
 * A rate-limited call is retried with an increasing delay — honouring `Retry-After` when
 * the provider sets one — and gives up as a `ProviderRateLimitError` rather than as a bare
 * response, so callers can't accidentally surface "returned 429" as user-facing text.
 */
export async function fetchProviderApi(
  fetchApi: ProviderApiFetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  retry: ProviderApiRetryOptions = {},
): Promise<Response> {
  const attempts = retry.attempts ?? RATE_LIMIT_RETRY_ATTEMPTS;
  const baseDelayMs = retry.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS;
  const maxInlineDelayMs = retry.maxInlineDelayMs ?? RATE_LIMIT_MAX_INLINE_DELAY_MS;
  const sleep = retry.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchApi(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(PROVIDER_HTTP_TIMEOUT_MS),
    });
    if (res.status !== 429) return res;

    const retryAfterMs = retryAfterMsFrom(res.headers);
    const backoffMs = retryAfterMs ?? baseDelayMs * 2 ** attempt;
    if (attempt >= attempts || backoffMs > maxInlineDelayMs) {
      throw new ProviderRateLimitError(retryAfterMs);
    }
    await sleep(backoffMs);
  }
}

export const RATE_LIMITED_PROVIDER_MESSAGE =
  "Usage service is busy — showing the last known values.";
const TIMED_OUT_MESSAGE = "Usage service did not answer in time.";
const GENERIC_MESSAGE = "Usage data is temporarily unavailable.";

/**
 * Plain-language text for a failed refresh.
 *
 * Provider transport errors are diagnostics, not copy: the raw ones read like
 * "Claude usage API returned 429". The detail stays in the daemon log; the card gets a
 * sentence a user can act on.
 */
export function friendlyProviderErrorMessage(error: unknown): string {
  if (error instanceof ProviderRateLimitError) return RATE_LIMITED_PROVIDER_MESSAGE;

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/\b429\b|rate limit|too many requests/i.test(message)) return RATE_LIMITED_PROVIDER_MESSAGE;
  if (/timeout|timed out|abort/i.test(message)) return TIMED_OUT_MESSAGE;
  return GENERIC_MESSAGE;
}

export function unavailableUsage(provider: {
  providerId: string;
  displayName: string;
  error?: string | null;
}): ProviderUsage {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    status: provider.error ? "error" : "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: provider.error ?? null,
  };
}

export function windowFromUsedPct(input: {
  id: string;
  label: string;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: ProviderUsageWindow["tone"];
}): ProviderUsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: ProviderUsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.tone) {
    window.tone = input.tone;
  }
  return window;
}

/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export function toneFromUsedPct(usedPct: number | null | undefined): ProviderUsageTone {
  if (typeof usedPct !== "number") return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export function balanceToneFromRemaining(
  remaining: number | null | undefined,
): ProviderUsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

/** Percentage of a limit consumed, or null when either side is unknown. */
export function usedPctOf(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return (used / limit) * 100;
}

export function toIsoStringOrNull(timestampMs: number): string | null {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
