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

  it("reads an agent that merely finished its turn as done, not as waiting on the user", () => {
    // The "attention" bucket is the agent's "I'm done, come look" notification —
    // requiresAttention with attentionReason "finished". It is NOT a pending
    // question, so the card must read green "Terminé", not amber.
    const attention: WorkspaceStateBucket = "attention";
    expect(deriveTaskTone(makeTask({ column: "in_progress" }), attention)).toBe("done");
    expect(deriveTaskTone(makeTask({ column: "done" }), attention)).toBe("done");
  });

  it("still reads a failed agent as needing the user", () => {
    const failed: WorkspaceStateBucket = "failed";
    expect(deriveTaskTone(makeTask({ column: "in_progress" }), failed)).toBe("attention");
  });

  it("spins the loader while the final check / deploy window is running, over a stale amber bucket", () => {
    // The user launched the final check or the deploy from a finished card. The
    // live bucket may still read needs_input until the agent starts streaming, but
    // the explicit running action must surface immediately as the working loader.
    const needsInput: WorkspaceStateBucket = "needs_input";
    expect(
      deriveTaskTone(makeTask({ column: "done", validation: { state: "running" } }), needsInput),
    ).toBe("running");
    expect(
      deriveTaskTone(makeTask({ column: "done", deployment: { state: "running" } }), needsInput),
    ).toBe("running");
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

describe("deriveTaskTone — a question typed in prose still calls for the user", () => {
  it("reads a finished agent whose last message asks something as attention", () => {
    // The daemon detected a question in the closing lines: no permission prompt
    // exists, the lifecycle only says "finished", yet the user does owe a reply.
    const attention: WorkspaceStateBucket = "attention";
    expect(deriveTaskTone(makeTask({ column: "in_progress" }), attention, true)).toBe("attention");
    expect(deriveTaskTone(makeTask({ column: "done" }), "done", true)).toBe("attention");
  });

  it("ignores the flag once the agent is running again", () => {
    // A question already superseded by a fresh run must not freeze the card on
    // amber — the loader is the truer signal.
    expect(deriveTaskTone(makeTask({ column: "in_progress" }), "running", true)).toBe("running");
  });

  it("still reads a finished agent with no question as done", () => {
    const attention: WorkspaceStateBucket = "attention";
    expect(deriveTaskTone(makeTask({ column: "in_progress" }), attention, false)).toBe("done");
    expect(deriveTaskTone(makeTask({ column: "in_progress" }), attention, undefined)).toBe("done");
  });

  it("keeps a running final check ahead of a pending question", () => {
    expect(
      deriveTaskTone(makeTask({ column: "done", validation: { state: "running" } }), "done", true),
    ).toBe("running");
  });
});
