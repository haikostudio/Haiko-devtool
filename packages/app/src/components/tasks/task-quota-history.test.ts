import { describe, expect, it } from "vitest";
import {
  appendSample,
  HISTORY_WINDOW_MS,
  MAX_SAMPLES,
  MIN_SAMPLE_INTERVAL_MS,
  sparklinePoints,
  type QuotaSample,
} from "./task-quota-history";

const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("appendSample", () => {
  it("adds a point once the throttle window has passed", () => {
    const samples = appendSample([{ t: T0, remainingPct: 90 }], {
      t: T0 + HOUR,
      remainingPct: 80,
    });
    expect(samples).toEqual([
      { t: T0, remainingPct: 90 },
      { t: T0 + HOUR, remainingPct: 80 },
    ]);
  });

  it("folds a too-recent reading into the last point", () => {
    const samples = appendSample([{ t: T0, remainingPct: 90 }], {
      t: T0 + MIN_SAMPLE_INTERVAL_MS - 1,
      remainingPct: 88,
    });
    expect(samples).toEqual([{ t: T0 + MIN_SAMPLE_INTERVAL_MS - 1, remainingPct: 88 }]);
  });

  it("drops readings older than the seven-day window", () => {
    const old: QuotaSample = { t: T0 - HISTORY_WINDOW_MS - 1, remainingPct: 100 };
    const samples = appendSample([old, { t: T0, remainingPct: 60 }], {
      t: T0 + HOUR,
      remainingPct: 55,
    });
    expect(samples.map((sample) => sample.remainingPct)).toEqual([60, 55]);
  });

  it("never grows past the cap", () => {
    let samples: QuotaSample[] = [];
    for (let index = 0; index < MAX_SAMPLES + 10; index += 1) {
      samples = appendSample(samples, { t: T0 + index * HOUR, remainingPct: 100 - index });
    }
    expect(samples).toHaveLength(MAX_SAMPLES);
  });
});

describe("sparklinePoints", () => {
  it("maps time to x and remaining share to y, full height meaning untouched", () => {
    const points = sparklinePoints(
      [
        { t: T0, remainingPct: 100 },
        { t: T0 + HOUR, remainingPct: 50 },
        { t: T0 + 2 * HOUR, remainingPct: 0 },
      ],
      { width: 100, height: 20 },
    );
    expect(points).toBe("0.0,0.0 50.0,10.0 100.0,20.0");
  });

  it("draws nothing without a real time span", () => {
    expect(sparklinePoints([{ t: T0, remainingPct: 50 }], { width: 100, height: 20 })).toBeNull();
    expect(
      sparklinePoints(
        [
          { t: T0, remainingPct: 50 },
          { t: T0, remainingPct: 40 },
        ],
        { width: 100, height: 20 },
      ),
    ).toBeNull();
  });
});
