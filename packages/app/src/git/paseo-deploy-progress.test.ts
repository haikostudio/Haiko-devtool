import { describe, expect, it } from "vitest";
import {
  DEPLOY_PHASES,
  easedPhaseFraction,
  formatDeployDuration,
  resolveDeployProgress,
} from "./paseo-deploy-progress.js";

const BASE = {
  deploying: true,
  phase: "build" as string | null,
  outcome: null,
  startedAt: 1_000_000,
  finishedAt: null,
  now: 1_000_000,
  phaseStartedAt: 1_000_000,
};

describe("formatDeployDuration", () => {
  it("reads as seconds under a minute", () => {
    expect(formatDeployDuration(0)).toBe("0 s");
    expect(formatDeployDuration(45_400)).toBe("45 s");
  });

  it("pads the seconds so the value doesn't jitter in width", () => {
    expect(formatDeployDuration(65_000)).toBe("1 min 05 s");
    expect(formatDeployDuration(190_000)).toBe("3 min 10 s");
  });

  it("never shows a negative duration", () => {
    expect(formatDeployDuration(-5_000)).toBe("0 s");
  });
});

describe("easedPhaseFraction", () => {
  it("starts a phase at its own lower bound", () => {
    expect(easedPhaseFraction(1, 0)).toBeCloseTo(0.12, 5);
  });

  it("keeps advancing while the phase lasts — the fix for the frozen bar", () => {
    const early = easedPhaseFraction(1, 30_000);
    const later = easedPhaseFraction(1, 120_000);
    expect(early).toBeGreaterThan(0.12);
    expect(later).toBeGreaterThan(early);
  });

  it("never crosses into the next phase's slice, however long it takes", () => {
    expect(easedPhaseFraction(1, 60 * 60_000)).toBeLessThan(0.85);
  });

  it("treats an unknown index as no progress", () => {
    expect(easedPhaseFraction(99, 10_000)).toBe(0);
  });
});

describe("resolveDeployProgress", () => {
  it("hides the block when no run is happening and none just finished", () => {
    const view = resolveDeployProgress({ ...BASE, deploying: false, phase: null });
    expect(view.visible).toBe(false);
  });

  it("shows a running build with its phase, elapsed time and a moving bar", () => {
    const view = resolveDeployProgress({ ...BASE, now: BASE.startedAt + 125_000 });
    expect(view.visible).toBe(true);
    expect(view.title).toBe("Construction du site…");
    expect(view.elapsedLabel).toBe("2 min 05 s");
    expect(view.percent).toBeGreaterThan(12);
    expect(view.percent).toBeLessThan(85);
    expect(view.failed).toBe(false);
    expect(view.succeeded).toBe(false);
  });

  it("keeps reporting a finished success after the build stops", () => {
    const view = resolveDeployProgress({
      ...BASE,
      deploying: false,
      phase: "done",
      outcome: "success",
      finishedAt: BASE.startedAt + 240_000,
    });
    expect(view.visible).toBe(true);
    expect(view.succeeded).toBe(true);
    expect(view.percent).toBe(100);
    expect(view.elapsedLabel).toBe("4 min 00 s");
    expect(view.activeIndex).toBe(-1);
  });

  it("reports a failure even when the phase never got past build", () => {
    const view = resolveDeployProgress({
      ...BASE,
      deploying: false,
      phase: "build",
      outcome: "failed",
      finishedAt: BASE.startedAt + 60_000,
    });
    expect(view.visible).toBe(true);
    expect(view.failed).toBe(true);
    expect(view.title).toBe("Déploiement interrompu");
    expect(view.percent).toBe(0);
  });

  it("freezes elapsed time once the run has finished", () => {
    const finished = { ...BASE, deploying: false, outcome: "success" as const, phase: "done" };
    const first = resolveDeployProgress({
      ...finished,
      finishedAt: BASE.startedAt + 90_000,
      now: BASE.startedAt + 90_000,
    });
    const muchLater = resolveDeployProgress({
      ...finished,
      finishedAt: BASE.startedAt + 90_000,
      now: BASE.startedAt + 900_000,
    });
    expect(muchLater.elapsedLabel).toBe(first.elapsedLabel);
  });

  it("says nothing about elapsed time when the daemon sends no start stamp", () => {
    const view = resolveDeployProgress({ ...BASE, startedAt: null });
    expect(view.elapsedLabel).toBeNull();
    expect(view.visible).toBe(true);
  });

  it("marks earlier steps done and highlights the reported one", () => {
    const view = resolveDeployProgress({ ...BASE, phase: "publish" });
    expect(view.reportedIndex).toBe(2);
    expect(view.activeIndex).toBe(2);
  });

  it("falls back to the first step for a phase it doesn't know", () => {
    const view = resolveDeployProgress({ ...BASE, phase: "start" });
    expect(view.title).toBe("Démarrage…");
    expect(view.reportedIndex).toBe(-1);
    expect(view.activeIndex).toBe(0);
  });

  it("keeps the phase slices contiguous and ordered", () => {
    let previousTo = 0;
    for (const phase of DEPLOY_PHASES) {
      expect(phase.from).toBeGreaterThanOrEqual(previousTo === 0 ? 0 : previousTo);
      expect(phase.to).toBeGreaterThanOrEqual(phase.from);
      previousTo = phase.to;
    }
    expect(DEPLOY_PHASES[DEPLOY_PHASES.length - 1]?.to).toBe(1);
  });
});
