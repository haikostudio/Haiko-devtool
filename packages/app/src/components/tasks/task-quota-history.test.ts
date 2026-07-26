import { describe, expect, it } from "vitest";
import {
  forecastDay,
  forecastRunOut,
  HISTORY_WINDOW_MS,
  sparklinePoints,
  toSamples,
  type QuotaSample,
} from "./task-quota-history";

const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("toSamples", () => {
  it("parses, sorts and drops readings older than the window", () => {
    const samples = toSamples(
      [
        { at: new Date(T0).toISOString(), remainingPct: 60 },
        { at: new Date(T0 - HISTORY_WINDOW_MS - HOUR).toISOString(), remainingPct: 100 },
        { at: new Date(T0 - HOUR).toISOString(), remainingPct: 70 },
      ],
      T0,
    );
    expect(samples.map((sample) => sample.remainingPct)).toEqual([70, 60]);
  });

  it("ignores unparseable timestamps", () => {
    expect(toSamples([{ at: "not-a-date", remainingPct: 50 }], T0)).toEqual([]);
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

describe("forecastRunOut", () => {
  const steady: QuotaSample[] = [
    { t: T0, remainingPct: 100 },
    { t: T0 + DAY, remainingPct: 80 },
  ];

  it("projects the run-out instant from the observed pace", () => {
    const forecast = forecastRunOut({ samples: steady, now: T0 + DAY });
    // 20 points a day, 80 left → four more days.
    expect(forecast).toEqual({ kind: "runsOut", at: T0 + 5 * DAY });
  });

  it("says the window lasts when the reset lands first", () => {
    const forecast = forecastRunOut({
      samples: steady,
      resetsAt: new Date(T0 + 3 * DAY).toISOString(),
      now: T0 + DAY,
    });
    expect(forecast).toEqual({ kind: "lasts" });
  });

  it("says the window lasts when nothing is being consumed", () => {
    const flat: QuotaSample[] = [
      { t: T0, remainingPct: 60 },
      { t: T0 + DAY, remainingPct: 60 },
    ];
    expect(forecastRunOut({ samples: flat, now: T0 + DAY })).toEqual({ kind: "lasts" });
  });

  it("stays silent on too short a stretch", () => {
    const short: QuotaSample[] = [
      { t: T0, remainingPct: 90 },
      { t: T0 + 30 * 60 * 1000, remainingPct: 80 },
    ];
    expect(forecastRunOut({ samples: short, now: T0 })).toEqual({ kind: "unknown" });
    expect(forecastRunOut({ samples: [], now: T0 })).toEqual({ kind: "unknown" });
  });
});

describe("forecastDay", () => {
  const noon = Date.parse("2026-07-20T12:00:00.000Z");

  it("separates today, tomorrow and later", () => {
    expect(forecastDay(noon + HOUR, noon)).toBe("today");
    expect(forecastDay(noon + DAY, noon)).toBe("tomorrow");
    expect(forecastDay(noon + 3 * DAY, noon)).toBe("later");
  });
});
