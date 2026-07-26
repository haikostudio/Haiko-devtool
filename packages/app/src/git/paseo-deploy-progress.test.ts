import { describe, expect, it } from "vitest";
import {
  DEPLOY_PHASES,
  describeCommitFileCount,
  describeCommitState,
  formatDeployDuration,
  resolveDeployActionLabel,
  resolveDeployProgress,
} from "./paseo-deploy-progress.js";

const BASE = {
  deploying: true,
  phase: "build" as string | null,
  outcome: null,
  startedAt: 1_000_000,
  finishedAt: null,
  now: 1_000_000,
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

describe("resolveDeployProgress", () => {
  it("hides the block when no run is happening and none just finished", () => {
    const view = resolveDeployProgress({ ...BASE, deploying: false, phase: null });
    expect(view.visible).toBe(false);
  });

  it("shows a running build with its phase, elapsed time and its step position", () => {
    const view = resolveDeployProgress({ ...BASE, now: BASE.startedAt + 125_000 });
    expect(view.visible).toBe(true);
    expect(view.title).toBe("Construction du site…");
    expect(view.elapsedLabel).toBe("2 min 05 s");
    expect(view.stepLabel).toBe("Étape 2 sur 3");
    expect(view.failed).toBe(false);
    expect(view.succeeded).toBe(false);
  });

  it("reports the same thing whatever the reader does with the sheet", () => {
    // The regression that made the sheet untrustworthy: progress was eased from a
    // client-side "first seen" timestamp, so closing and reopening the sheet
    // restarted the creep and the number went DOWN. Progress now depends only on
    // daemon-reported values, so a remount cannot change what is displayed.
    const first = resolveDeployProgress({ ...BASE, now: BASE.startedAt + 125_000 });
    const afterReopen = resolveDeployProgress({ ...BASE, now: BASE.startedAt + 125_000 });
    expect(afterReopen).toEqual(first);
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
    expect(view.elapsedLabel).toBe("4 min 00 s");
    expect(view.stepLabel).toBeNull();
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
    expect(view.stepLabel).toBeNull();
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
    expect(view.stepLabel).toBe("Étape 3 sur 3");
  });

  it("falls back to the first step for a phase it doesn't know, without claiming one", () => {
    const view = resolveDeployProgress({ ...BASE, phase: "start" });
    expect(view.title).toBe("Démarrage…");
    expect(view.reportedIndex).toBe(-1);
    expect(view.activeIndex).toBe(0);
    expect(view.stepLabel).toBeNull();
  });

  it("ends on the finish line", () => {
    expect(DEPLOY_PHASES[DEPLOY_PHASES.length - 1]?.key).toBe("done");
  });
});

describe("resolveDeployActionLabel", () => {
  const BUTTON = {
    inProgress: false,
    triggering: false,
    phase: null as string | null,
    outcome: null,
    canDeploy: true,
    selectionCount: 0,
    hasTrunkPending: false,
    blockedCount: 0,
  };

  it("follows the running step so the button never lies about what is happening", () => {
    expect(resolveDeployActionLabel({ ...BUTTON, inProgress: true, phase: "publish" })).toBe(
      "Publication en ligne…",
    );
  });

  it("offers a retry after a failed publication", () => {
    expect(resolveDeployActionLabel({ ...BUTTON, outcome: "failed", hasTrunkPending: true })).toBe(
      "Réessayer la publication",
    );
  });

  it("counts the ticked ateliers, singular and plural", () => {
    expect(resolveDeployActionLabel({ ...BUTTON, selectionCount: 1 })).toBe(
      "Mettre en place 1 atelier",
    );
    expect(resolveDeployActionLabel({ ...BUTTON, selectionCount: 3 })).toBe(
      "Mettre en place 3 ateliers",
    );
  });

  it("falls back to the trunk, then to preparation, then to nothing to do", () => {
    expect(resolveDeployActionLabel({ ...BUTTON, hasTrunkPending: true })).toBe(
      "Publier les changements du projet",
    );
    expect(resolveDeployActionLabel({ ...BUTTON, blockedCount: 2 })).toBe(
      "Lancer la mise en place",
    );
    expect(resolveDeployActionLabel(BUTTON)).toBe("Rien à publier");
  });
});

describe("describeCommitState", () => {
  it("gives every change a status a reader can act on", () => {
    expect(describeCommitState("pending").label).toBe("En attente");
    expect(describeCommitState("deploying").label).toBe("En cours de publication");
    expect(describeCommitState("deployed").label).toBe("En ligne");
    expect(describeCommitState("failed").label).toBe("Non publié");
  });

  it("spins only while the change is actually on its way up", () => {
    expect(describeCommitState("deploying").busy).toBe(true);
    expect(describeCommitState("deployed").busy).toBe(false);
    expect(describeCommitState("pending").busy).toBe(false);
  });

  it("never claims a change is online when the status is unknown", () => {
    // An older host sends no status. Reading that as "published" would be the
    // one mistake that makes the whole window untrustworthy.
    expect(describeCommitState(undefined).label).toBe("En attente");
    expect(describeCommitState(null).tone).toBe("neutral");
  });

  it("colours the four states apart", () => {
    const tones = (["pending", "deploying", "deployed", "failed"] as const).map(
      (state) => describeCommitState(state).tone,
    );
    expect(new Set(tones).size).toBe(4);
  });
});

describe("describeCommitFileCount", () => {
  it("counts files in plain words, and says nothing when there are none", () => {
    expect(describeCommitFileCount(0)).toBeNull();
    expect(describeCommitFileCount(1)).toBe("1 fichier modifié");
    expect(describeCommitFileCount(4)).toBe("4 fichiers modifiés");
  });
});
