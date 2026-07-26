/**
 * Progress model for the Paseo self-host deploy sheet ("À déployer").
 *
 * There is deliberately NO percentage here. The daemon only knows a coarse phase
 * (`save` → `build` → `publish` → `done`, or `error`); an earlier version turned
 * that into an eased percentage that crept inside each phase's slice. It read as
 * precision the mechanism does not have, and — because the easing was anchored on
 * a client-side "when did I first see this phase" timestamp — closing and
 * reopening the sheet restarted the creep, so the number went BACKWARDS. A
 * progress number that moves down is worse than no number at all.
 *
 * What is shown instead is only what is actually known: which step is running,
 * which steps are done, and how long the run has been going. All of it derived
 * from daemon-reported values, so it is identical on every device and survives a
 * reload.
 *
 * Kept separate from the component and pure, so it is unit-tested without a
 * renderer.
 */

/** How the last finished run ended, as reported by the daemon. */
export type PaseoDeployOutcome = "success" | "failed";

export interface DeployPhaseSpec {
  key: string;
  label: string;
}

export const DEPLOY_PHASES: readonly DeployPhaseSpec[] = [
  { key: "save", label: "Sauvegarde" },
  { key: "build", label: "Construction" },
  { key: "publish", label: "Publication" },
  { key: "done", label: "En ligne" },
];

/** Steps that represent work in progress (the last one is the finish line). */
const WORKING_STEP_COUNT = DEPLOY_PHASES.length - 1;

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

/** Where one change stands in the publication pipeline. */
export type PaseoDeployCommitState = "pending" | "deploying" | "deployed" | "failed";

export interface DeployCommitStateView {
  /** Plain-language status shown next to the change. */
  label: string;
  /** Which colour family the badge uses. */
  tone: "neutral" | "active" | "success" | "danger";
  /** True while this change is on its way up (drives the little spinner). */
  busy: boolean;
}

/**
 * Status of a single change, in words a reader can act on. A change that has no
 * status (older daemon) reads as waiting — never as published, because claiming
 * something is online without knowing is the one mistake that destroys trust in
 * the whole window.
 */
export function describeCommitState(
  state: PaseoDeployCommitState | null | undefined,
): DeployCommitStateView {
  switch (state) {
    case "deploying":
      return { label: "En cours de publication", tone: "active", busy: true };
    case "deployed":
      return { label: "En ligne", tone: "success", busy: false };
    case "failed":
      return { label: "Non publié", tone: "danger", busy: false };
    default:
      return { label: "En attente", tone: "neutral", busy: false };
  }
}

/** "3 fichiers modifiés" — the one-line summary of a change's detail. */
export function describeCommitFileCount(count: number): string | null {
  if (count <= 0) return null;
  return count > 1 ? `${count} fichiers modifiés` : "1 fichier modifié";
}

export interface DeployActionLabelInput {
  /** A run is happening, or the click hasn't been acknowledged yet. */
  inProgress: boolean;
  /** Between the click and the daemon's first status poll. */
  triggering: boolean;
  phase: string | null | undefined;
  outcome: PaseoDeployOutcome | null | undefined;
  /** There is something to publish and nothing is running. */
  canDeploy: boolean;
  /** Ticked ateliers to fold into this publication. */
  selectionCount: number;
  /** Work already sitting on the deploy trunk. */
  hasTrunkPending: boolean;
  /** Ateliers the mechanism has to prepare before they can ship. */
  blockedCount: number;
}

/** Wording of the sheet's single action, so the button always says what it does. */
export function resolveDeployActionLabel(input: DeployActionLabelInput): string {
  if (input.inProgress) {
    return deployPhaseLabel(input.phase, input.triggering);
  }
  if (input.outcome === "failed" && input.canDeploy) {
    return "Réessayer la publication";
  }
  if (input.selectionCount > 0) {
    const noun = input.selectionCount > 1 ? "ateliers" : "atelier";
    return `Mettre en place ${input.selectionCount} ${noun}`;
  }
  if (input.hasTrunkPending) {
    return "Publier les changements du projet";
  }
  if (input.blockedCount > 0) {
    return "Lancer la mise en place";
  }
  return "Rien à publier";
}

export interface DeployProgressInput {
  deploying: boolean;
  phase: string | null | undefined;
  outcome: PaseoDeployOutcome | null | undefined;
  /** Daemon timestamps, so elapsed survives a reload mid-build. */
  startedAt: number | null | undefined;
  finishedAt: number | null | undefined;
  now: number;
}

export interface DeployProgressView {
  /** False when there is nothing to report (no run, no outcome to show). */
  visible: boolean;
  title: string;
  /** Elapsed time to display, or null when it isn't known yet. */
  elapsedLabel: string | null;
  /** "Étape 2 sur 3" — the honest position, or null when it isn't known. */
  stepLabel: string | null;
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

  // A finished run freezes its elapsed time; a running one keeps counting. With
  // no start timestamp (older daemon) we simply say nothing rather than guess.
  let elapsedLabel: string | null = null;
  if (input.startedAt != null) {
    const end = input.finishedAt ?? (input.deploying ? input.now : input.startedAt);
    const elapsedMs = Math.max(0, end - input.startedAt);
    if (elapsedMs > 0) elapsedLabel = formatDeployDuration(elapsedMs);
  }

  // Only claimed while a working step is actually reported — never for the
  // "start" placeholder, a failure, or the finish line.
  const stepLabel =
    !failed && !succeeded && reportedIndex >= 0 && reportedIndex < WORKING_STEP_COUNT
      ? `Étape ${reportedIndex + 1} sur ${WORKING_STEP_COUNT}`
      : null;

  let title = deployPhaseLabel(input.phase, true);
  if (failed) title = "Déploiement interrompu";
  else if (succeeded) title = "En ligne ✅";

  return {
    visible: input.deploying || succeeded || failed,
    title,
    elapsedLabel,
    stepLabel,
    failed,
    succeeded,
    activeIndex: failed || succeeded ? -1 : activeIndex,
    reportedIndex,
  };
}
