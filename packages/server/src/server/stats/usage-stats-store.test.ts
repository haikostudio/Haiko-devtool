import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";

import { UsageStatsStore } from "./usage-stats-store.js";

const logger = pino({ level: "silent" });

describe("UsageStatsStore", () => {
  let baseDir: string;
  let store: UsageStatsStore;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-stats-"));
    store = new UsageStatsStore(baseDir, logger);
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("turns cumulative usage into deltas and buckets by hour and project", async () => {
    const t1 = new Date(2026, 6, 15, 9, 10, 0);
    const t2 = new Date(2026, 6, 15, 10, 20, 0);

    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.5 },
      timestamp: t1,
      countTurn: true,
    });
    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { inputTokens: 300, outputTokens: 120, totalCostUsd: 1.25 },
      timestamp: t2,
      countTurn: true,
    });
    await store.flush();

    const [day] = await store.query({ days: 1, now: t2 });
    expect(day.date).toBe("2026-07-15");
    expect(day.hours.map((hour) => hour.hour)).toEqual([9, 10]);

    const nine = day.hours[0].projects[0];
    expect(nine).toMatchObject({ key: "/repo/alpha", inputTokens: 100, outputTokens: 50 });
    const ten = day.hours[1].projects[0];
    expect(ten).toMatchObject({ inputTokens: 200, outputTokens: 70, turns: 1 });
    expect(ten.costUsd).toBeCloseTo(0.75);

    const dayProject = day.projects[0];
    expect(dayProject).toMatchObject({
      key: "/repo/alpha",
      name: "alpha",
      inputTokens: 300,
      outputTokens: 120,
      turns: 2,
      agentCount: 1,
    });
    expect(dayProject.costUsd).toBeCloseTo(1.25);
  });

  it("treats a shrinking counter as a session reset, not a correction", async () => {
    const now = new Date(2026, 6, 15, 9, 0, 0);
    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { inputTokens: 1000 },
      timestamp: now,
      countTurn: false,
    });
    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { inputTokens: 400 },
      timestamp: now,
      countTurn: false,
    });
    await store.flush();

    const [day] = await store.query({ days: 1, now });
    expect(day.projects[0].inputTokens).toBe(1400);
  });

  it("keeps the baseline for fields absent from an event", async () => {
    const now = new Date(2026, 6, 15, 9, 0, 0);
    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { inputTokens: 1000, totalCostUsd: 1 },
      timestamp: now,
      countTurn: false,
    });
    // Context-window-only update (Claude stream events) must not reset baselines.
    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { contextWindowUsedTokens: 5000 },
      timestamp: now,
      countTurn: false,
    });
    store.noteAgentUsage({
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      usage: { inputTokens: 1100, totalCostUsd: 1.2 },
      timestamp: now,
      countTurn: false,
    });
    await store.flush();

    const [day] = await store.query({ days: 1, now });
    expect(day.projects[0].inputTokens).toBe(1100);
    expect(day.projects[0].costUsd).toBeCloseTo(1.2);
  });

  it("dedupes agents across hours at the day level and persists across instances", async () => {
    const nine = new Date(2026, 6, 15, 9, 0, 0);
    const ten = new Date(2026, 6, 15, 10, 0, 0);
    await store.recordDelta({
      timestamp: nine,
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costUsd: 0.01,
      turns: 1,
    });
    await store.recordDelta({
      timestamp: ten,
      agentId: "agent-1",
      projectKey: "/repo/alpha",
      projectName: "alpha",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costUsd: 0.01,
      turns: 1,
    });
    await store.recordDelta({
      timestamp: ten,
      agentId: "agent-2",
      projectKey: "/repo/beta",
      projectName: "beta",
      inputTokens: 20,
      outputTokens: 8,
      cachedInputTokens: 4,
      costUsd: 0.02,
      turns: 1,
    });
    await store.flush();

    // Fresh instance: reads from disk.
    const reloaded = new UsageStatsStore(baseDir, logger);
    const [day] = await reloaded.query({ days: 1, now: ten });
    const alpha = day.projects.find((project) => project.key === "/repo/alpha");
    expect(alpha?.agentCount).toBe(1);
    expect(day.hours.find((hour) => hour.hour === 10)?.projects).toHaveLength(2);
  });

  it("returns empty days for dates with no data", async () => {
    const now = new Date(2026, 6, 15, 12, 0, 0);
    const days = await store.query({ days: 3, now });
    expect(days.map((day) => day.date)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
    expect(days.every((day) => day.hours.length === 0 && day.projects.length === 0)).toBe(true);
  });
});
