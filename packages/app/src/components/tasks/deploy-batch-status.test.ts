import { describe, expect, it } from "vitest";
import {
  batchProgressRatio,
  batchProgressStep,
  formatBatchProgressStep,
  isRecapWorthShowing,
  PHASES,
} from "./deploy-batch-status";

describe("batchProgressRatio", () => {
  it("starts on the first of the eight reported steps", () => {
    expect(batchProgressStep({ state: "running", phase: null })).toEqual({
      current: 1,
      total: 8,
    });
    expect(batchProgressRatio({ state: "running", phase: null })).toBe(1 / 8);
  });

  it("grows with each visible publication phase", () => {
    const prepare = batchProgressRatio({ state: "running", phase: "prepare" });
    const push = batchProgressRatio({ state: "running", phase: "push" });
    const daemon = batchProgressRatio({ state: "running", phase: "daemon" });
    const site = batchProgressRatio({ state: "running", phase: "site" });
    const publish = batchProgressRatio({ state: "running", phase: "publish" });
    const restart = batchProgressRatio({ state: "running", phase: "restart" });
    expect(prepare).toBeLessThan(push);
    expect(push).toBeLessThan(daemon);
    expect(daemon).toBeLessThan(site);
    expect(site).toBeLessThan(publish);
    expect(publish).toBeLessThan(restart);
    expect(publish).toBeLessThan(1);
  });

  it("reports the final restart as the last step", () => {
    expect(batchProgressStep({ state: "running", phase: "restart" })).toEqual({
      current: 8,
      total: 8,
    });
  });

  it("covers the complete publication path in order", () => {
    expect(PHASES).toEqual([
      "start",
      "prepare",
      "push",
      "verify",
      "daemon",
      "site",
      "publish",
      "restart",
    ]);
    expect(PHASES.map((phase) => batchProgressStep({ state: "running", phase }).current)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("formats the translated label for the banner", () => {
    expect(
      formatBatchProgressStep(
        batchProgressStep({ state: "running", phase: "start" }),
        "Début du déploiement",
      ),
    ).toBe("1/8 — Début du déploiement");
  });

  it("falls back to the first step for a phase sent by a newer daemon", () => {
    expect(batchProgressStep({ state: "running", phase: "future-phase" })).toEqual({
      current: 1,
      total: 8,
    });
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
