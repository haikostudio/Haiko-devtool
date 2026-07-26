import type { ProviderUsageHistorySample } from "@getpaseo/protocol/messages";

/** One reading of a weekly allowance: when it was taken, and how much was left. */
export interface QuotaSample {
  t: number;
  remainingPct: number;
}

/** How far back the curve reaches. */
export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Below this span the readings say nothing about a trend, so no forecast. */
export const MIN_FORECAST_SPAN_MS = 2 * 60 * 60 * 1000;

/** Turns the host's wire samples into plain timestamps, oldest first. */
export function toSamples(
  wireSamples: ProviderUsageHistorySample[],
  now: number = Date.now(),
): QuotaSample[] {
  const cutoff = now - HISTORY_WINDOW_MS;
  return wireSamples
    .map((sample) => ({ t: Date.parse(sample.at), remainingPct: sample.remainingPct }))
    .filter((sample) => Number.isFinite(sample.t) && sample.t >= cutoff)
    .sort((a, b) => a.t - b.t);
}

export interface SparklineSize {
  width: number;
  height: number;
}

/**
 * The polyline for a history curve, as an SVG `points` string.
 *
 * Y is the share still LEFT, like every other gauge here: the line falls as the
 * week is spent. Returns null when there is not enough spread to draw anything
 * honest — one point, or every point taken at the same instant.
 */
export function sparklinePoints(samples: QuotaSample[], size: SparklineSize): string | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return null;
  const span = last.t - first.t;
  if (span <= 0) return null;

  return samples
    .map((sample) => {
      const x = ((sample.t - first.t) / span) * size.width;
      const y = size.height - (Math.max(0, Math.min(100, sample.remainingPct)) / 100) * size.height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export type QuotaForecast =
  | { kind: "unknown" }
  /** Consumption is flat or slow enough that the window refills first. */
  | { kind: "lasts" }
  /** At the observed rate the allowance empties at this instant. */
  | { kind: "runsOut"; at: number };

export interface ForecastInput {
  samples: QuotaSample[];
  /** When the window refills, if the provider says. */
  resetsAt?: string | null;
  now?: number;
}

/**
 * Projects when the allowance runs out if the last stretch's pace holds.
 *
 * Deliberately a straight line through the observed stretch rather than
 * anything cleverer: the point is "am I burning this faster than the week can
 * take", and a fitted curve would only dress up a guess. Says nothing at all
 * when the readings are too short, too flat, or already past the reset.
 */
export function forecastRunOut({
  samples,
  resetsAt,
  now = Date.now(),
}: ForecastInput): QuotaForecast {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return { kind: "unknown" };

  const span = last.t - first.t;
  if (span < MIN_FORECAST_SPAN_MS) return { kind: "unknown" };

  const spent = first.remainingPct - last.remainingPct;
  // Not consuming (or the window refilled mid-stretch): nothing to project.
  if (spent <= 0) return { kind: "lasts" };

  const ratePerMs = spent / span;
  const runsOutAt = last.t + last.remainingPct / ratePerMs;
  if (runsOutAt <= now) return { kind: "runsOut", at: now };

  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (Number.isFinite(resetMs) && runsOutAt >= resetMs) return { kind: "lasts" };

  return { kind: "runsOut", at: runsOutAt };
}

export type ForecastDay = "today" | "tomorrow" | "later";

/** Which wording the forecast needs: today, tomorrow, or a named weekday. */
export function forecastDay(at: number, now: number = Date.now()): ForecastDay {
  const startOfDay = (ms: number) => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  return "later";
}
