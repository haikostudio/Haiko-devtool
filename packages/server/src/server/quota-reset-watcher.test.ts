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
    runKeepAlive,
  });
  return { watcher, runKeepAlive, setUsage: (usage) => (current = usage) };
}

describe("QuotaResetWatcher", () => {
  it("does nothing while a window is still counting down", async () => {
    const h = makeWatcher({ now: () => 0 });
    h.setUsage(claudeUsage(new Date(3_600_000).toISOString()));
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();
  });

  it("restarts the countdown once the window lapses", async () => {
    let nowMs = 0;
    const h = makeWatcher({ now: () => nowMs });

    h.setUsage(claudeUsage(new Date(3_600_000).toISOString()));
    await h.watcher.tick();
    expect(h.runKeepAlive).not.toHaveBeenCalled();

    nowMs = 3_600_001;
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
    let nowMs = 0;
    const h = makeWatcher({ now: () => nowMs });
    h.setUsage(claudeUsage(null));

    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);

    nowMs = 60_000;
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);

    nowMs = 11 * 60_000;
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(2);
  });

  it("clears its fired state once a fresh window appears", async () => {
    let nowMs = 0;
    const h = makeWatcher({ now: () => nowMs });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);

    nowMs = 120_000;
    h.setUsage(claudeUsage(new Date(nowMs + 5 * 3_600_000).toISOString()));
    await h.watcher.tick();

    nowMs = 120_000 + 5 * 3_600_000 + 1;
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

  it("falls back to the home directory when no Claude agent is loaded", async () => {
    const h = makeWatcher({ now: () => 5_000, agents: [] });
    h.setUsage(claudeUsage(null));
    await h.watcher.tick();
    expect(h.runKeepAlive).toHaveBeenCalledTimes(1);
    expect(typeof h.runKeepAlive.mock.calls[0][0].cwd).toBe("string");
  });
});
