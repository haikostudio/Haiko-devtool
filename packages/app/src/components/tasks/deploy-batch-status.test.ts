import { describe, expect, it } from "vitest";
import {
  batchProgressRatio,
  batchProgressStep,
  formatBatchProgressStep,
  isRecapWorthShowing,
  STEP_KEYS,
  stepKeyFor,
} from "./deploy-batch-status";

describe("batchProgressStep", () => {
  it("starts on the first of the eight reported steps", () => {
    expect(batchProgressStep({ state: "running", phase: null })).toEqual({
      current: 1,
      total: 8,
    });
    expect(batchProgressRatio({ state: "running", phase: null })).toBe(1 / 8);
  });

  it("grows with each visible publication phase, in order", () => {
    const order = ["prepare", "push", "verify", "daemon", "site", "publish", "restart", "done"];
    expect(order.map((phase) => batchProgressStep({ state: "running", phase }).current)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("names the eight steps once, ending on the restart and its completion", () => {
    expect(STEP_KEYS).toEqual([
      "prepare",
      "push",
      "verify",
      "daemon",
      "site",
      "publish",
      "restart",
      "done",
    ]);
  });

  it("reads the label from the number, so 'done' is 8/8 — never 1/8", () => {
    // The daemon pushes phase "done" onto the batch a beat before it flips the
    // state to "success"; that used to resolve to step 1 and print
    // "1/8 — Terminé". It must now resolve to the last step.
    const done = batchProgressStep({ state: "running", phase: "done" });
    expect(done).toEqual({ current: 8, total: 8 });
    expect(stepKeyFor(done)).toBe("done");
  });

  it("never rewinds below the floor already reached this run", () => {
    // Reached step 5 (site); an out-of-order or unknown phase must hold, not drop.
    expect(batchProgressStep({ state: "running", phase: "prepare" }, 5).current).toBe(5);
    expect(batchProgressStep({ state: "running", phase: "future-phase" }, 5).current).toBe(5);
    expect(batchProgressRatio({ state: "running", phase: "prepare" }, 5)).toBe(5 / 8);
  });

  it("folds the front aliases onto the first step", () => {
    for (const phase of ["start", "merge"]) {
      expect(batchProgressStep({ state: "running", phase }).current).toBe(1);
    }
  });

  it("advances past an unknown phase from a newer daemon instead of resetting", () => {
    // No floor known yet: an unrecognised phase holds at the start rather than
    // pretending to be a later step.
    expect(batchProgressStep({ state: "running", phase: "future-phase" }).current).toBe(1);
  });

  it("every step key resolves to an existing, ordered position", () => {
    STEP_KEYS.forEach((key, index) => {
      const step = batchProgressStep({ state: "running", phase: key });
      expect(step.current).toBe(index + 1);
      expect(stepKeyFor(step)).toBe(key);
    });
  });

  it("formats the translated label for the banner", () => {
    expect(
      formatBatchProgressStep(
        batchProgressStep({ state: "running", phase: "prepare" }),
        "Enregistrement des changements…",
      ),
    ).toBe("1/8 — Enregistrement des changements…");
  });

  it("is full once the run is over, whichever way it ended", () => {
    expect(batchProgressRatio({ state: "success", phase: "done" })).toBe(1);
    expect(batchProgressRatio({ state: "failed", phase: "error" })).toBe(1);
    expect(batchProgressStep({ state: "success", phase: "done" })).toEqual({
      current: 8,
      total: 8,
    });
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
