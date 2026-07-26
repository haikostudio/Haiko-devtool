import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderUsage } from "../../server/messages.js";
import { HISTORY_RETENTION_MS, ProviderUsageHistoryStore } from "./history-store.js";

const logger = pino({ level: "silent" });
const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function usage(
  windows: ProviderUsage["windows"],
  overrides: Partial<ProviderUsage> = {},
): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    planLabel: "Max",
    windows,
    ...overrides,
  };
}

describe("ProviderUsageHistoryStore", () => {
  let dir: string;
  let store: ProviderUsageHistoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-quota-history-"));
    store = new ProviderUsageHistoryStore(join(dir, "history.json"), logger);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("traces the session and weekly windows, ignoring per-model ones", async () => {
    await store.record(
      [
        usage([
          { id: "five_hour", label: "Session", remainingPct: 80 },
          { id: "weekly", label: "Weekly", remainingPct: 60 },
          { id: "weekly_opus", label: "Weekly · Opus", remainingPct: 10 },
        ]),
      ],
      T0,
    );

    const series = await store.list(T0);
    expect(series.map((entry) => entry.kind).sort()).toEqual(["session", "weekly"]);
    const weekly = series.find((entry) => entry.kind === "weekly");
    expect(weekly?.samples).toEqual([{ at: new Date(T0).toISOString(), remainingPct: 60 }]);
  });

  it("derives what is left from usage when the provider only reports usage", async () => {
    await store.record([usage([{ id: "weekly", label: "Weekly", usedPct: 75 }])], T0);
    const [weekly] = await store.list(T0);
    expect(weekly?.samples[0]?.remainingPct).toBe(25);
  });

  it("appends across polls but folds readings taken too close together", async () => {
    await store.record([usage([{ id: "weekly", label: "Weekly", remainingPct: 90 }])], T0);
    await store.record([usage([{ id: "weekly", label: "Weekly", remainingPct: 89 }])], T0 + 60_000);
    await store.record([usage([{ id: "weekly", label: "Weekly", remainingPct: 70 }])], T0 + HOUR);

    const [weekly] = await store.list(T0 + HOUR);
    expect(weekly?.samples.map((sample) => sample.remainingPct)).toEqual([89, 70]);
  });

  it("forgets readings older than the retention window", async () => {
    await store.record([usage([{ id: "weekly", label: "Weekly", remainingPct: 100 }])], T0);
    const later = T0 + HISTORY_RETENTION_MS + HOUR;
    await store.record([usage([{ id: "weekly", label: "Weekly", remainingPct: 40 }])], later);

    const [weekly] = await store.list(later);
    expect(weekly?.samples.map((sample) => sample.remainingPct)).toEqual([40]);
  });

  it("records nothing for a provider that is not available", async () => {
    await store.record(
      [usage([{ id: "weekly", label: "Weekly", remainingPct: 50 }], { status: "unavailable" })],
      T0,
    );
    expect(await store.list(T0)).toEqual([]);
  });

  it("survives a restart by reading the file back", async () => {
    await store.record([usage([{ id: "weekly", label: "Weekly", remainingPct: 55 }])], T0);
    const reopened = new ProviderUsageHistoryStore(join(dir, "history.json"), logger);
    const [weekly] = await reopened.list(T0);
    expect(weekly?.samples[0]?.remainingPct).toBe(55);
  });

  it("starts fresh instead of throwing on a corrupt file", async () => {
    const corrupt = new ProviderUsageHistoryStore(join(dir, "missing", "history.json"), logger);
    expect(await corrupt.list(T0)).toEqual([]);
  });
});
