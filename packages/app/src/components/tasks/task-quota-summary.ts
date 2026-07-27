import type {
  ProviderUsage,
  ProviderUsageListPayload,
  ProviderUsageWindow,
} from "@/provider-usage/types";

/** At or below this share of the allowance left the gauge turns amber… */
export const REMAINING_WARN_PCT = 20;
/** …and at or below this one it turns red. Both are on REMAINING, not used. */
export const REMAINING_DANGER_PCT = 10;

/**
 * "neutral" is the no-number state (grey). A window that DID report a number is
 * always one of the three traffic-light tones: ok (green) / warn / danger.
 */
export type QuotaTone = "neutral" | "ok" | "warn" | "danger";

export interface QuotaProviderSummary {
  providerId: string;
  displayName: string;
  /** Host verdict: "available" = configured & reporting, "error" = configured
   * but the fetch failed, "unavailable" = not configured/reachable at all. */
  status: ProviderUsage["status"];
  planLabel: string | null;
  /** The short rolling window every plan is packed against (Claude 5h / Codex session). */
  session: ProviderUsageWindow | null;
  /** The account-wide weekly allowance, never a per-model scoped one. */
  weekly: ProviderUsageWindow | null;
  /** False when the provider answered but reported no usable number. */
  hasData: boolean;
  /** Why a provider has no number, when it said so. Shown instead of a gauge. */
  error: string | null;
}

export interface QuotaSummary {
  providers: QuotaProviderSummary[];
  /**
   * The tightest weekly headroom across providers — what the low-quota warning
   * watches, because the week runs out as soon as the FIRST provider does.
   */
  weeklyRemainingPct: number | null;
  /**
   * What the header ring draws: the same tightest headroom, but falling back to
   * a provider's rolling window when its plan reports no weekly allowance at all.
   */
  ringRemainingPct: number | null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Remaining share of a window, 0–100, or null when the provider reports no number. */
export function remainingPercent(window: ProviderUsageWindow | null | undefined): number | null {
  if (!window) return null;
  if (typeof window.remainingPct === "number") return clamp(window.remainingPct);
  if (typeof window.usedPct === "number") return clamp(100 - window.usedPct);
  return null;
}

// Providers name their windows differently, so ids are matched first (they are
// stable) and labels only as a fallback (they are human copy and get reworded).
const SESSION_ID = /^(five_hour|session|rolling)$/i;
const SESSION_LABEL = /5\s*-?\s*h|five|session|glissant/i;
const WEEKLY_ID = /^(weekly|seven_day|week)$/i;
const WEEKLY_LABEL = /week|hebdo|7\s*-?\s*[dj]\b/i;

export function pickSessionWindow(windows: ProviderUsageWindow[]): ProviderUsageWindow | null {
  return (
    windows.find((window) => SESSION_ID.test(window.id)) ??
    windows.find((window) => SESSION_LABEL.test(window.label)) ??
    null
  );
}

export function pickWeeklyWindow(windows: ProviderUsageWindow[]): ProviderUsageWindow | null {
  // Exact ids win: Claude also emits per-model windows labelled "Weekly · Opus",
  // and one model's allowance must never stand in for the account-wide one.
  return (
    windows.find((window) => WEEKLY_ID.test(window.id)) ??
    windows.find((window) => WEEKLY_LABEL.test(window.label)) ??
    null
  );
}

export function toneForRemaining(remaining: number | null): QuotaTone {
  if (remaining === null) return "neutral";
  if (remaining <= REMAINING_DANGER_PCT) return "danger";
  if (remaining <= REMAINING_WARN_PCT) return "warn";
  return "ok";
}

function summarizeProvider(usage: ProviderUsage): QuotaProviderSummary {
  const windows = usage.windows;
  const session = pickSessionWindow(windows);
  const weekly = pickWeeklyWindow(windows);
  return {
    providerId: usage.providerId,
    displayName: usage.displayName,
    status: usage.status,
    planLabel: usage.planLabel ?? null,
    session,
    weekly,
    hasData: remainingPercent(session) !== null || remainingPercent(weekly) !== null,
    error: usage.error ?? null,
  };
}

/**
 * Turns the raw provider-usage payload into what the header ring and its menu
 * need: one row per connected model, plus the single number the ring draws.
 *
 * Only providers the user actually runs stay in the list. The host marks a
 * provider "unavailable" when it is not configured or reachable at all — those
 * (Copilot, Cursor, Z.ai, Grok, Kimi, MiniMax when unused) only ever say
 * "usage unavailable" and add nothing, so they are dropped. A provider that IS
 * configured but whose fetch failed comes back as "error", not "unavailable":
 * it keeps its row and says why, so a Claude row is never silently missing from
 * a Claude-driven board. Rows without a number stay; only the ring math skips
 * them.
 */
export function buildQuotaSummary(payload: ProviderUsageListPayload | null): QuotaSummary {
  const providers = (payload?.providers ?? [])
    .map(summarizeProvider)
    .filter((provider) => provider.status !== "unavailable");
  const withData = providers.filter((provider) => provider.hasData);

  const weeklyValues = withData
    .map((provider) => remainingPercent(provider.weekly))
    .filter((value): value is number => value !== null);

  // Not every plan reports a weekly allowance — Codex on a session-only plan
  // reports just the rolling window. Falling back to it keeps the ring showing a
  // real number instead of an empty circle nobody can even see in the header.
  const ringValues = withData
    .map((provider) => remainingPercent(provider.weekly) ?? remainingPercent(provider.session))
    .filter((value): value is number => value !== null);

  return {
    providers,
    weeklyRemainingPct: weeklyValues.length > 0 ? Math.min(...weeklyValues) : null,
    ringRemainingPct: ringValues.length > 0 ? Math.min(...ringValues) : null,
  };
}

export type ResetUnit = "minutes" | "hours" | "days";

export interface ResetCountdown {
  unit: ResetUnit;
  count: number;
}

/** Time left before a window resets, as a count + unit the caller localizes. */
export function resetCountdown(
  iso: string | null | undefined,
  now: number = Date.now(),
): ResetCountdown | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMs = target - now;
  if (diffMs <= 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return { unit: "minutes", count: Math.max(1, minutes) };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
