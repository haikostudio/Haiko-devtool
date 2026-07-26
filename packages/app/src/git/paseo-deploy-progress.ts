/**
 * Progress model for the Paseo self-host deploy sheet ("À déployer").
 *
 * The daemon can only report a coarse phase (`save` → `build` → `publish` →
 * `done`, or `error`). Rendering that as one fixed percentage per phase made the
 * bar sit at exactly 50 % for the whole `build` step — several minutes on this
 * host — which reads as a hang, not as work. So the bar eases across each
 * phase's own slice while the phase lasts, and the elapsed time is spelled out.
 *
 * Kept separate from the component and pure, so the arithmetic is unit-tested
 * without a renderer.
 */

/** How the last finished run ended, as reported by the daemon. */
export type PaseoDeployOutcome = "success" | "failed";

export interface DeployPhaseSpec {
  key: string;
  label: string;
  /** Slice of the bar this phase owns, as fractions of the total. */
  from: number;
  to: number;
  /**
   * Rough duration on this host. Only sets the easing speed — the bar never
   * crosses into the next phase's slice before the daemon says so, so a slow
   * phase keeps creeping and a fast one is never overtaken by the estimate.
   */
  expectedMs: number;
}

export const DEPLOY_PHASES: readonly DeployPhaseSpec[] = [
  { key: "save", label: "Sauvegarde", from: 0.02, to: 0.12, expectedMs: 20_000 },
  { key: "build", label: "Construction", from: 0.12, to: 0.85, expectedMs: 300_000 },
  { key: "publish", label: "Publication", from: 0.85, to: 0.97, expectedMs: 25_000 },
  { key: "done", label: "En ligne", from: 1, to: 1, expectedMs: 0 },
];

/** Human label for a phase; `triggering` covers the gap before the first poll. */
export function deployPhaseLabel(phase: string | null | undefined, triggering: boolean): string {
  switch (phase) {
    case "save":
      return "Sauvegarde…";
    case "build":
      return "Construction du site…";
    case "publish":
      return "Publication en ligne…";
    case "done":
      return "En ligne ✅";
    case "error":
      return "Mise en place à reprendre";
    default:
      return triggering ? "Démarrage…" : "Déploiement en cours…";
  }
}

/** "2 min 05 s" — plain elapsed time, so a long build reads as work, not a hang. */
export function formatDeployDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return `${minutes} min ${seconds.toString().padStart(2, "0")} s`;
}

/**
 * Position inside a phase's slice: eases toward the next mark without ever
 * reaching it, so the bar always has somewhere to go.
 */
export function easedPhaseFraction(index: number, elapsedInPhaseMs: number): number {
  const entry = DEPLOY_PHASES[index];
  if (!entry) return 0;
  if (entry.expectedMs <= 0) return entry.to;
  const ratio = 1 - Math.exp(-Math.max(0, elapsedInPhaseMs) / entry.expectedMs);
  return entry.from + (entry.to - entry.from) * ratio;
}

export interface DeployProgressInput {
  deploying: boolean;
  phase: string | null | undefined;
  outcome: PaseoDeployOutcome | null | undefined;
  /** Daemon timestamps, so elapsed survives a reload mid-build. */
  startedAt: number | null | undefined;
  finishedAt: number | null | undefined;
  now: number;
  /** When the client last observed the reported phase change. */
  phaseStartedAt: number;
}

export interface DeployProgressView {
  /** False when there is nothing to report (no run, no outcome to show). */
  visible: boolean;
  title: string;
  percent: number;
  /** Elapsed time to display, or null when it isn't known yet. */
  elapsedLabel: string | null;
  failed: boolean;
  succeeded: boolean;
  /** Index of the step to highlight; -1 when no step is active. */
  activeIndex: number;
  /** Index of the daemon-reported phase, or -1 when it maps to no step. */
  reportedIndex: number;
}

export function resolveDeployProgress(input: DeployProgressInput): DeployProgressView {
  const failed = input.outcome === "failed" || input.phase === "error";
  const succeeded = input.outcome === "success" || input.phase === "done";
  const reportedIndex = DEPLOY_PHASES.findIndex((entry) => entry.key === input.phase);
  const activeIndex = reportedIndex < 0 ? 0 : reportedIndex;

  let fraction = 0;
  if (succeeded) {
    fraction = 1;
  } else if (!failed) {
    fraction = easedPhaseFraction(activeIndex, input.now - input.phaseStartedAt);
  }

  // A finished run freezes its elapsed time; a running one keeps counting. With
  // no start timestamp (older daemon) we simply say nothing rather than guess.
  let elapsedLabel: string | null = null;
  if (input.startedAt != null) {
    const end = input.finishedAt ?? (input.deploying ? input.now : input.startedAt);
    const elapsedMs = Math.max(0, end - input.startedAt);
    if (elapsedMs > 0) elapsedLabel = formatDeployDuration(elapsedMs);
  }

  let title = deployPhaseLabel(input.phase, true);
  if (failed) title = "Déploiement interrompu";
  else if (succeeded) title = "En ligne ✅";

  return {
    visible: input.deploying || succeeded || failed,
    title,
    percent: Math.round(fraction * 100),
    elapsedLabel,
    failed,
    succeeded,
    activeIndex: failed || succeeded ? -1 : activeIndex,
    reportedIndex,
  };
}
