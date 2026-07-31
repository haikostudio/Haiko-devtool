import type { TaskDeployBatch } from "@getpaseo/protocol/tasks/types";

/**
 * Pure, view-free helpers for the deploy banner. They live apart from the
 * `.tsx` component so tests can import them without dragging React Native and
 * native-only modules (lucide, unistyles) into a node test env — importing the
 * component itself fails to load, which silently zeroed this file's test suite.
 */

/**
 * The publication's eight visible steps, in the exact order the run reaches
 * them, ending on the mise-en-ligne, the engine restart, and its completion.
 *
 * Both the step NUMBER and the step LABEL are read from this one list (the
 * number is the 1-based index, the label is the i18n key at that index). They
 * therefore share a single source of truth, so "1/8 — Terminé" — a number and a
 * label that disagree — can no longer be constructed.
 */
export const STEP_KEYS = [
  "prepare",
  "push",
  "verify",
  "daemon",
  "site",
  "publish",
  "restart",
  "done",
] as const;

export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_COUNT = STEP_KEYS.length;

/**
 * Every phase token the build script or the daemon can write, mapped to its
 * 1-based position among the eight steps. Kept TOTAL on purpose: an
 * out-of-order token — most notably `done`, which the daemon pushes onto the
 * batch record a beat before it flips the state to "success" — must resolve to
 * its real rank (8) instead of collapsing to step 1. That collapse is exactly
 * what made the counter jump backwards and print "1/8 — Terminé".
 *
 * Aliases fold onto the step they belong to: `start`/`merge` sit at the front
 * with `prepare`; the legacy `save`/`build` tokens map to the nearest real
 * step. `error` sits at the end — a failed run shows its recap, not this
 * counter, so its rank only matters as a non-regressing terminal value.
 */
const PHASE_STEP: Record<string, number> = {
  start: 1,
  merge: 1,
  save: 1,
  prepare: 1,
  push: 2,
  verify: 3,
  build: 4,
  daemon: 4,
  site: 5,
  publish: 6,
  restart: 7,
  done: 8,
  error: 8,
};

export interface BatchProgressStep {
  current: number;
  total: number;
}

/**
 * The numbered step to display. `floor` is the highest step already reached in
 * this run: the result never drops below it, so the counter is monotonic. A
 * known phase resolves to its rank; an unrecognised or skipped phase HOLDS at
 * `floor` instead of rewinding to the start.
 */
export function batchProgressStep(
  batch: Pick<TaskDeployBatch, "state" | "phase">,
  floor = 1,
): BatchProgressStep {
  const total = STEP_COUNT;
  if (batch.state !== "running") {
    return { current: total, total };
  }
  const rank = batch.phase ? PHASE_STEP[batch.phase] : undefined;
  const current = Math.min(Math.max(rank ?? floor, floor, 1), total);
  return { current, total };
}

/**
 * The i18n phase key for a step. The label shown next to "N/8" is derived from
 * the number this way, never from the raw phase token, so the two can never
 * describe different steps.
 */
export function stepKeyFor(step: BatchProgressStep): StepKey {
  const index = Math.min(Math.max(step.current, 1), STEP_COUNT) - 1;
  return STEP_KEYS[index];
}

/** Combines the reported position with the translated label shown in the banner. */
export function formatBatchProgressStep(step: BatchProgressStep, label: string): string {
  return `${step.current}/${step.total} — ${label}`;
}

/** A finished recap stops being news after a day; it hides itself then. */
export const RECAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How far along the run is, as a 0→1 ratio, honouring the same monotonic floor. */
export function batchProgressRatio(
  batch: Pick<TaskDeployBatch, "state" | "phase">,
  floor = 1,
): number {
  if (batch.state !== "running") {
    return 1;
  }
  const step = batchProgressStep(batch, floor);
  return step.current / step.total;
}

/** True when a finished batch is still recent enough to be worth reporting. */
export function isRecapWorthShowing(
  batch: Pick<TaskDeployBatch, "state" | "finishedAt">,
  nowMs: number,
): boolean {
  if (batch.state === "running") {
    return false;
  }
  if (!batch.finishedAt) {
    return true;
  }
  const finishedMs = Date.parse(batch.finishedAt);
  return Number.isNaN(finishedMs) || nowMs - finishedMs < RECAP_MAX_AGE_MS;
}
