import type { TaskDeployBatch } from "@getpaseo/protocol/tasks/types";

/**
 * Pure, view-free helpers for the deploy batch banner. They live apart from the
 * `.tsx` component so tests can import them without dragging React Native and
 * native-only modules (lucide, unistyles) into a node test env — importing the
 * component itself fails to load, which silently zeroed this file's test suite.
 */

/** The build script's coarse steps, in the order it writes them. */
export const PHASES = ["save", "build", "publish"] as const;

/** A finished recap stops being news after a day; it hides itself then. */
export const RECAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How far along the run is, as a 0→1 ratio, from the phase it reports. */
export function batchProgressRatio(batch: Pick<TaskDeployBatch, "state" | "phase">): number {
  if (batch.state !== "running") {
    return 1;
  }
  const index = PHASES.indexOf((batch.phase ?? "") as (typeof PHASES)[number]);
  // Before the first phase lands, show a sliver so the bar never reads as empty.
  return index < 0 ? 0.08 : (index + 1) / (PHASES.length + 1);
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
