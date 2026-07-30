import type { TaskDeployBatch } from "@getpaseo/protocol/tasks/types";

/**
 * Pure, view-free helpers for the deploy batch banner. They live apart from the
 * `.tsx` component so tests can import them without dragging React Native and
 * native-only modules (lucide, unistyles) into a node test env — importing the
 * component itself fails to load, which silently zeroed this file's test suite.
 */

/** The publication's visible steps, in the order the orchestrator reaches them. */
export const PHASES = [
  "start",
  "prepare",
  "push",
  "verify",
  "daemon",
  "site",
  "publish",
  "restart",
] as const;

export interface BatchProgressStep {
  current: number;
  total: number;
}

/** The numbered step reported by the publication agent, ready for display. */
export function batchProgressStep(
  batch: Pick<TaskDeployBatch, "state" | "phase">,
): BatchProgressStep {
  const total = PHASES.length;
  if (batch.state !== "running") {
    return { current: total, total };
  }
  const phase = batch.phase ?? "start";
  const index = PHASES.indexOf(phase as (typeof PHASES)[number]);
  return { current: index < 0 ? 1 : index + 1, total };
}

/** Combines the agent-reported position with the translated label shown in the banner. */
export function formatBatchProgressStep(step: BatchProgressStep, label: string): string {
  return `${step.current}/${step.total} — ${label}`;
}

/** A finished recap stops being news after a day; it hides itself then. */
export const RECAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How far along the run is, as a 0→1 ratio, from the phase it reports. */
export function batchProgressRatio(batch: Pick<TaskDeployBatch, "state" | "phase">): number {
  if (batch.state !== "running") {
    return 1;
  }
  const step = batchProgressStep(batch);
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
