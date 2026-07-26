import { describe, expect, it } from "vitest";
import type { ProviderUsage, ProviderUsageListPayload } from "@/provider-usage/types";
import {
  buildQuotaSummary,
  pickSessionWindow,
  pickWeeklyWindow,
  remainingPercent,
  resetCountdown,
  toneForRemaining,
} from "./task-quota-summary";

function usage(overrides: Partial<ProviderUsage>): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    planLabel: "Max",
    windows: [],
    ...overrides,
  };
}

function payload(providers: ProviderUsage[]): ProviderUsageListPayload {
  return { requestId: "req", fetchedAt: "2026-07-26T10:00:00.000Z", providers };
}

describe("remainingPercent", () => {
  it("prefers the reported remaining share", () => {
    expect(remainingPercent({ id: "weekly", label: "Weekly", remainingPct: 42, usedPct: 10 })).toBe(
      42,
    );
  });

  it("derives remaining from used when only usage is reported", () => {
    expect(remainingPercent({ id: "weekly", label: "Weekly", usedPct: 60 })).toBe(40);
  });

  it("returns null when the provider reports no number", () => {
    expect(remainingPercent({ id: "weekly", label: "Weekly" })).toBeNull();
    expect(remainingPercent(null)).toBeNull();
  });
});

describe("window picking", () => {
  it("matches Claude's five-hour window and its account-wide weekly one", () => {
    const windows = [
      { id: "five_hour", label: "Session", usedPct: 20 },
      { id: "weekly", label: "Weekly", usedPct: 30 },
      { id: "weekly_opus", label: "Weekly · Opus", usedPct: 90 },
    ];
    expect(pickSessionWindow(windows)?.id).toBe("five_hour");
    expect(pickWeeklyWindow(windows)?.id).toBe("weekly");
  });

  it("never lets a per-model weekly window stand in for the account one", () => {
    const windows = [{ id: "weekly_opus", label: "Weekly · Opus", usedPct: 90 }];
    expect(pickWeeklyWindow(windows)?.id).toBe("weekly_opus");
    expect(pickWeeklyWindow([{ id: "weekly", label: "Weekly" }, ...windows])?.id).toBe("weekly");
  });
});

describe("buildQuotaSummary", () => {
  it("reports the tightest weekly headroom across providers", () => {
    const summary = buildQuotaSummary(
      payload([
        usage({ windows: [{ id: "weekly", label: "Weekly", remainingPct: 55 }] }),
        usage({
          providerId: "codex",
          displayName: "Codex",
          windows: [
            { id: "session", label: "Session", remainingPct: 80 },
            { id: "weekly", label: "Weekly", remainingPct: 12 },
          ],
        }),
      ]),
    );
    expect(summary.providers).toHaveLength(2);
    expect(summary.weeklyRemainingPct).toBe(12);
  });

  it("drops providers with no usable number when another one reported", () => {
    const summary = buildQuotaSummary(
      payload([
        usage({ providerId: "gemini", displayName: "Gemini", status: "unavailable" }),
        usage({ windows: [{ id: "weekly", label: "Weekly", remainingPct: 70 }] }),
      ]),
    );
    expect(summary.providers.map((provider) => provider.providerId)).toEqual(["claude"]);
  });

  it("keeps every provider when none reported, so the menu can explain", () => {
    const summary = buildQuotaSummary(
      payload([
        usage({ status: "unavailable" }),
        usage({ providerId: "codex", displayName: "Codex" }),
      ]),
    );
    expect(summary.providers).toHaveLength(2);
    expect(summary.weeklyRemainingPct).toBeNull();
  });

  it("returns an empty summary when usage was never fetched", () => {
    expect(buildQuotaSummary(null)).toEqual({ providers: [], weeklyRemainingPct: null });
  });
});

describe("toneForRemaining", () => {
  it("warns before the allowance runs dry and alarms at the end", () => {
    expect(toneForRemaining(60)).toBe("neutral");
    expect(toneForRemaining(25)).toBe("warn");
    expect(toneForRemaining(10)).toBe("danger");
    expect(toneForRemaining(null)).toBe("neutral");
  });
});

describe("resetCountdown", () => {
  const now = Date.parse("2026-07-26T10:00:00.000Z");

  it("counts down in minutes, hours then days", () => {
    expect(resetCountdown("2026-07-26T10:45:00.000Z", now)).toEqual({ unit: "minutes", count: 45 });
    expect(resetCountdown("2026-07-26T13:30:00.000Z", now)).toEqual({ unit: "hours", count: 3 });
    expect(resetCountdown("2026-07-29T10:00:00.000Z", now)).toEqual({ unit: "days", count: 3 });
  });

  it("returns nothing for a past or missing reset", () => {
    expect(resetCountdown("2026-07-26T09:00:00.000Z", now)).toBeNull();
    expect(resetCountdown(null, now)).toBeNull();
  });
});
