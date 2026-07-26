import { describe, expect, it } from "vitest";
import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { KanbanTask } from "@/data/tasks";
import { deriveTaskTone } from "./task-status-tone";

// Minimal valid KanbanTask; override only the fields a test cares about.
function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Some task",
    tags: [],
    column: "backlog",
    order: 0,
    origin: "manual",
    normalizedTitle: "some task",
    links: { agentIds: [] },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  } as KanbanTask;
}

describe("deriveTaskTone — loader reflects the agent's real activity", () => {
  it("shows the loader while the live agent is genuinely running", () => {
    const task = makeTask({ column: "in_progress", schedule: { state: "running", attempts: 1 } });
    expect(deriveTaskTone(task, "running")).toBe("running");
  });

  it("shows the loader during scheduler spin-up before a live agent exists", () => {
    expect(
      deriveTaskTone(
        makeTask({ column: "validated", schedule: { state: "pending_estimate", attempts: 0 } }),
        undefined,
      ),
    ).toBe("running");
    expect(
      deriveTaskTone(
        makeTask({ column: "validated", schedule: { state: "launching", attempts: 0 } }),
        undefined,
      ),
    ).toBe("running");
  });

  it("stops the loader once the agent has gone idle, even if the card is still in the in-progress column", () => {
    // Agent finished its turn → live bucket is "done". A stale "running" schedule
    // flag and the in_progress column must NOT keep the spinner turning.
    const task = makeTask({ column: "in_progress", schedule: { state: "running", attempts: 1 } });
    expect(deriveTaskTone(task, "done")).toBe("done");
  });

  it("stops the loader when the agent was cut / died (no live agent at all)", () => {
    // The task agent's process is gone → the card has no live bucket. It must read
    // as a finished green light, not a loader spinning in the void.
    const task = makeTask({
      column: "in_progress",
      schedule: { state: "running", attempts: 1 },
      links: { agentIds: ["a1"], taskAgentId: "a1" },
    });
    expect(deriveTaskTone(task, undefined)).toBe("done");
  });

  it("ignores a stale spin-up flag once the card is already in progress", () => {
    // A "launching"/"pending_estimate" flag that lingers after the card reached
    // the in-progress column is a leftover the server can no longer clear. With
    // no live running agent it must NOT resurrect the loader.
    expect(
      deriveTaskTone(
        makeTask({ column: "in_progress", schedule: { state: "launching", attempts: 1 } }),
        "done",
      ),
    ).toBe("done");
    expect(
      deriveTaskTone(
        makeTask({ column: "in_progress", schedule: { state: "pending_estimate", attempts: 1 } }),
        undefined,
      ),
    ).toBe("done");
    expect(
      deriveTaskTone(makeTask({ column: "in_progress", refinement: "pending" }), undefined),
    ).toBe("done");
  });

  it("keeps amber priority when the agent is waiting on the user", () => {
    const task = makeTask({ column: "in_progress" });
    const needsInput: WorkspaceStateBucket = "needs_input";
    expect(deriveTaskTone(task, needsInput)).toBe("attention");
  });

  it("reads a queued (awaiting-slot) task as scheduled blue, not running", () => {
    const task = makeTask({
      column: "scheduled",
      schedule: { state: "awaiting_slot", attempts: 0 },
    });
    expect(deriveTaskTone(task, undefined)).toBe("scheduled");
  });

  it("leaves an untouched backlog task dark", () => {
    expect(deriveTaskTone(makeTask({ column: "backlog" }), undefined)).toBeNull();
  });
});
