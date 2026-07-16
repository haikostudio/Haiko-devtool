import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ProviderUsage } from "./messages.js";
import { QuotaResetWatcher } from "./quota-reset-watcher.js";

const logger = pino({ level: "silent" });

function claudeUsage(
  resetsAt: string | null,
  status: ProviderUsage["status"] = "available",
): { providers: ProviderUsage[] } {
  return {
    providers: [
      {
        providerId: "claude",
        displayName: "Claude",
        status,
        planLabel: null,
        windows:
          resetsAt === null
            ? []
            : [{ id: "five_hour", label: "Session", usedPct: 10, remainingPct: 90, resetsAt }],
        balances: [],
        details: [],
        error: null,
      },
    ],
  };
}

interface Harness {
  watcher: QuotaResetWatcher;
  runKeepAlive: ReturnType<typeof vi.fn>;
  setUsage: (usage: { providers: ProviderUsage[] }) => void;
}

function makeWatcher(options?: {
  now?: () => number;
  agents?: Array<{
    id: string;
    provider: string;
    internal?: boolean;
    updatedAt: Date;
    cwd: string;
  }>;
}): Harness {
  let current = claudeUsage(null);
  const runKeepAlive = vi.fn(async () => {});
  const agents = options?.agents ?? [
    { id: "a", provider: "claude", internal: false, updatedAt: new Date(1000), cwd: "/repo/app" },
  ];
  const agentManager = { listAgents: () => agents };
  const watcher = new QuotaResetWatcher({
    agentManager: agentManager as never,
    providerUsageService: { listUsage: async () => current } as never,
    logger,
    now: options?.now,
    refireCooldownMs: 10 * 60_000,
    // Interpret quiet hours in UTC so tests can pick unambiguous instants.
    quietHours: { startHour: 1, endHour: 6, timeZone: "UTC" },
    runKeepAlive,
  });
  return { watcher, runKeepAlive, setUsage: (usage) => (current = usage) };
}

const utc = (iso: string): number => Date.parse(iso);

describe("QuotaResetWatcher", () => {
  it("does nothing while a window is still counting down", async () => {
    const h = makeWatcher({ now: () => 0 });
    h.setUsage(claudeUsage(new Date(3_600_000).toISOString()));
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();
  });

  it("restarts the countdown once the window lapses", async () => {
    let nowMs = utc("2026-07-16T09:00:00Z");
    const h = makeWatcher({ now: () => nowMs });

    h.setUsage(claudeUsage("2026-07-16T10:00:00Z"));
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();

    nowMs = utc("2026-07-16T10:00:01Z");
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);
    // Runs in the most recent Claude agent's directory.
    expect(h.runKeepAlive.mock.calls[0][0].cwd).toBe("/repo/app");
  });

  it("restarts when the usage API reports no active window at all", async () => {
    const h = makeWatcher({ now: () => 5_000 });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);
  });

  it("does not fire again until the cooldown elapses", async () => {
    let nowMs = utc("2026-07-16T09:00:00Z");
    const h = makeWatcher({ now: () => nowMs });
    h.setUsage(claudeUsage(null));

    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);

    nowMs = utc("2026-07-16T09:01:00Z");
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);

    nowMs = utc("2026-07-16T09:11:00Z");
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(2);
  });

  it("clears its fired state once a fresh window appears", async () => {
    let nowMs = utc("2026-07-16T09:00:00Z");
    const h = makeWatcher({ now: () => nowMs });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);

    // Fresh window registered, 5 hours out → active, state resets.
    nowMs = utc("2026-07-16T09:02:00Z");
    h.setUsage(claudeUsage("2026-07-16T14:02:00Z"));
    await h.watcher.tick();

    // Window lapses again mid-afternoon → fires immediately (state cleared).
    nowMs = utc("2026-07-16T14:02:01Z");
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(2);
  });

  it("does not fire when Claude is not authenticated", async () => {
    const h = makeWatcher({ now: () => 5_000 });
    h.setUsage(claudeUsage(null, "unavailable"));
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();
  });

  it("does not fire during the overnight quiet hours", async () => {
    // 02:30 UTC is inside the 01:00–06:00 quiet window.
    const h = makeWatcher({ now: () => utc("2026-07-16T02:30:00Z") });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();
  });

  it("resumes and re-anchors a fresh window when quiet hours end", async () => {
    let nowMs = utc("2026-07-16T02:30:00Z");
    const h = makeWatcher({ now: () => nowMs });
    h.setUsage(claudeUsage(null));

    // Quiet: nothing happens.
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();

    // 06:00 UTC: quiet hours over, lapsed window → fire immediately.
    nowMs = utc("2026-07-16T06:00:00Z");
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);
  });

  it("keeps firing outside quiet hours", async () => {
    // 09:00 UTC is well outside 01:00–06:00.
    const h = makeWatcher({ now: () => utc("2026-07-16T09:00:00Z") });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);
  });

  it("falls back to the home directory when no Claude agent is loaded", async () => {
    const h = makeWatcher({ now: () => 5_000, agents: [] });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);
    expect(typeof h.runKeepAlive.mock.calls[0][0].cwd).toBe("string");
  });
});
