import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import { getScheduleBadge } from "./task-card-badge";

// Minimal in-progress task fixture; individual specs override the fields that
// drive the badge (approval, schedule, executionHold, planReadyAt).
function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Task",
    tags: [],
    column: "in_progress",
    order: 0,
    origin: "manual",
    normalizedTitle: "task",
    links: { agentIds: ["a1"], primaryAgentId: "a1" },
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("getScheduleBadge", () => {
  it("shows an amber 'waiting for your reply' badge when the live agent is waiting", () => {
    // No board field explains the pause — the amber tone comes from the agent
    // blocking on a question/permission. This is the case the card used to miss.
    const badge = getScheduleBadge(makeTask(), "attention");
    expect(badge).toEqual({ labelKey: "tasks.card.awaitingReply", variant: "warning" });
  });

  it("prefers the precise approval wording over the generic waiting badge", () => {
    const badge = getScheduleBadge(makeTask({ approval: { state: "pending" } }), "attention");
    expect(badge).toEqual({ labelKey: "tasks.approval.pending", variant: "warning" });
  });

  it("prefers the held-for-review wording over the generic waiting badge", () => {
    const badge = getScheduleBadge(makeTask({ executionHold: true }), "attention");
    expect(badge).toEqual({ labelKey: "tasks.schedule.heldForReview", variant: "warning" });
  });

  it("keeps the red failure badge over the amber waiting badge", () => {
    const badge = getScheduleBadge(
      makeTask({ schedule: { state: "failed", attempts: 1 } }),
      "attention",
    );
    expect(badge).toEqual({ labelKey: "tasks.schedule.failed", variant: "error" });
  });

  it("the waiting badge wins over a stale 'running' schedule state", () => {
    // The agent asked a question mid-run: the schedule may still read "running",
    // but the amber tone (attention) must surface, not a green "in progress".
    const badge = getScheduleBadge(
      makeTask({ schedule: { state: "running", attempts: 1 } }),
      "attention",
    );
    expect(badge).toEqual({ labelKey: "tasks.card.awaitingReply", variant: "warning" });
  });

  it("shows the deploying badge the instant the deploy window opens, over a stale waiting badge", () => {
    // The user pressed "Lancer le déploiement": the server opened a running deploy
    // window, but the live bucket may still read attention until the agent streams.
    // The explicit action must win so the card says "Publication en cours".
    const badge = getScheduleBadge(makeTask({ deployment: { state: "running" } }), "attention");
    expect(badge).toEqual({ labelKey: "tasks.card.deploying", variant: "success" });
  });

  it("shows the final-check badge while the validation window is running", () => {
    const badge = getScheduleBadge(makeTask({ validation: { state: "running" } }), "attention");
    expect(badge).toEqual({ labelKey: "tasks.card.finalCheck", variant: "success" });
  });

  it("surfaces a failed deploy / final check as an error badge", () => {
    expect(getScheduleBadge(makeTask({ deployment: { state: "failed" } }), null)).toEqual({
      labelKey: "tasks.card.deployFailed",
      variant: "error",
    });
    expect(getScheduleBadge(makeTask({ validation: { state: "failed" } }), null)).toEqual({
      labelKey: "tasks.card.finalCheckFailed",
      variant: "error",
    });
  });

  it("shows the green running badge when the agent is actually working", () => {
    const badge = getScheduleBadge(
      makeTask({ schedule: { state: "running", attempts: 1 } }),
      "running",
    );
    expect(badge).toEqual({ labelKey: "tasks.schedule.running", variant: "success" });
  });

  it("returns no badge for a quiet in-progress task", () => {
    expect(getScheduleBadge(makeTask(), "running")).toBeNull();
  });

  it("says a light queued task is launching soon, not a flat 'awaiting'", () => {
    // Light (under both thresholds), "auto", no reason recorded: the scheduler
    // launches it on the next tick — so the badge should say so.
    const badge = getScheduleBadge(
      makeTask({
        column: "scheduled",
        schedule: { state: "awaiting_slot", attempts: 0 },
        estimate: { quotaPercent: 5, estimatedMinutes: 10 } as KanbanTask["estimate"],
      }),
      null,
    );
    expect(badge).toEqual({ labelKey: "tasks.schedule.launchingSoon", variant: "success" });
  });

  it("names the quota wait when the scheduler held the task back for quota", () => {
    const badge = getScheduleBadge(
      makeTask({
        column: "scheduled",
        schedule: { state: "awaiting_slot", attempts: 0, waitingReason: "quota" },
        estimate: { quotaPercent: 5, estimatedMinutes: 10 } as KanbanTask["estimate"],
      }),
      null,
    );
    expect(badge).toEqual({ labelKey: "tasks.schedule.awaitingQuota" });
  });

  it("keeps the generic 'awaiting' badge for a heavy off-peak task (paired with its time)", () => {
    // Heavy (over the quota threshold): parked for the off-peak window, with the
    // concrete "Vers 01:00" time rendered next to this badge on the card.
    const badge = getScheduleBadge(
      makeTask({
        column: "scheduled",
        schedule: { state: "awaiting_slot", attempts: 0 },
        estimate: { quotaPercent: 40, estimatedMinutes: 90 } as KanbanTask["estimate"],
      }),
      null,
    );
    expect(badge).toEqual({ labelKey: "tasks.schedule.awaiting" });
  });
});
