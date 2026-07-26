/** One reading of a weekly allowance: when it was taken, and how much was left. */
export interface QuotaSample {
  t: number;
  remainingPct: number;
}

/** How far back the sparkline reaches. */
export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Readings closer together than this overwrite the last point instead of adding
 * one. Quotas are read every time the menu opens, and without this a busy hour
 * would crowd the whole week out of the curve.
 */
export const MIN_SAMPLE_INTERVAL_MS = 30 * 60 * 1000;

/** Hard cap, so a long-lived install can't grow the stored history without bound. */
export const MAX_SAMPLES = 96;

/**
 * Adds a reading to a provider's history: drops anything older than the window,
 * folds a too-recent reading into the last point, and keeps the list bounded.
 */
export function appendSample(samples: QuotaSample[], sample: QuotaSample): QuotaSample[] {
  const cutoff = sample.t - HISTORY_WINDOW_MS;
  const kept = samples.filter((entry) => entry.t >= cutoff && entry.t <= sample.t);
  const last = kept.at(-1);
  if (last && sample.t - last.t < MIN_SAMPLE_INTERVAL_MS) {
    return [...kept.slice(0, -1), sample];
  }
  return [...kept, sample].slice(-MAX_SAMPLES);
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
