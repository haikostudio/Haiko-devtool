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
});
