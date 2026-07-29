import { describe, expect, it } from "vitest";
import { batchProgressRatio, isRecapWorthShowing } from "./deploy-batch-status";

describe("batchProgressRatio", () => {
  it("never reads as empty before the first phase lands", () => {
    expect(batchProgressRatio({ state: "running", phase: null })).toBeGreaterThan(0);
    expect(batchProgressRatio({ state: "running", phase: null })).toBeLessThan(0.25);
  });

  it("grows with each visible publication phase", () => {
    const prepare = batchProgressRatio({ state: "running", phase: "prepare" });
    const daemon = batchProgressRatio({ state: "running", phase: "daemon" });
    const site = batchProgressRatio({ state: "running", phase: "site" });
    const publish = batchProgressRatio({ state: "running", phase: "publish" });
    const restart = batchProgressRatio({ state: "running", phase: "restart" });
    expect(prepare).toBeLessThan(daemon);
    expect(daemon).toBeLessThan(site);
    expect(site).toBeLessThan(publish);
    expect(publish).toBeLessThan(restart);
    expect(publish).toBeLessThan(1);
  });

  it("is full once the run is over, whichever way it ended", () => {
    expect(batchProgressRatio({ state: "success", phase: "done" })).toBe(1);
    expect(batchProgressRatio({ state: "failed", phase: "error" })).toBe(1);
  });
});

describe("isRecapWorthShowing", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");

  it("says nothing while the batch is still running — the progress bar speaks", () => {
    expect(isRecapWorthShowing({ state: "running", finishedAt: null }, now)).toBe(false);
  });

  it("reports a run that just finished", () => {
    expect(
      isRecapWorthShowing({ state: "success", finishedAt: "2026-07-28T11:40:00.000Z" }, now),
    ).toBe(true);
  });

  it("stops reporting a run from another day", () => {
    expect(
      isRecapWorthShowing({ state: "success", finishedAt: "2026-07-26T11:40:00.000Z" }, now),
    ).toBe(false);
  });

  it("shows an outcome with no end stamp rather than swallowing it", () => {
    expect(isRecapWorthShowing({ state: "failed", finishedAt: null }, now)).toBe(true);
  });
});
