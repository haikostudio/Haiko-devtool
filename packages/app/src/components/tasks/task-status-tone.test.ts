import { describe, expect, it } from "vitest";
import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { KanbanTask } from "@/data/tasks";
import { deriveTaskTone, shouldShowVoyant } from "./task-status-tone";

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

  it("shows the pending light while the run is armed but the agent is still spinning up", () => {
    // The scheduler moved the card into "En cours" and set schedule.state to
    // "running", but the (re)used agent is still initializing → its live bucket
    // reads "done" (or it isn't in the agent list yet → undefined). This must
    // surface the warming-up "En attente d'exécution" light, NEVER a premature
    // green "Terminé".
    const task = makeTask({ column: "in_progress", schedule: { state: "running", attempts: 1 } });
    expect(deriveTaskTone(task, "done")).toBe("pending");
    expect(deriveTaskTone(task, undefined)).toBe("pending");
  });

  it("reads a finished run (schedule cleared) as done, not a spinner", () => {
    // On completion the server clears schedule to null and marks the card
    // ready_for_review; the card stays in in_progress awaiting the user's final
    // check. Same idle "done" bucket, but with no armed schedule it reads as the
    // quiet green terminal light.
    const finished = makeTask({
      column: "in_progress",
      schedule: null,
      progress: "ready_for_review",
    });
    expect(deriveTaskTone(finished, "done")).toBe("done");
    expect(deriveTaskTone(finished, undefined)).toBe("done");
  });

  it("ignores a stale non-execution spin-up flag once the card is already in progress", () => {
    // A "launching"/"pending_estimate" flag or a "refinement: pending" that
    // lingers after the card reached the in-progress column is a leftover the
    // server can no longer clear. Only the execution arm (schedule.state
    // "running") reads as pending; these analysis leftovers must NOT resurrect a
    // loader — they fall through to the terminal green.
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

  it("hands off pending → running the instant the agent reports live", () => {
    // The armed run's agent starts streaming: the live bucket flips to "running"
    // and the working loader takes over from the warming-up pending light.
    const task = makeTask({ column: "in_progress", schedule: { state: "running", attempts: 1 } });
    expect(deriveTaskTone(task, "running")).toBe("running");
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

  it("flips a running final check / deploy to amber when its agent is blocked on a permission", () => {
    // The final check or deploy is running, but its agent has stopped on a live
    // permission prompt (needs_input). The action cannot advance without an
    // answer, so the card must go amber and shake — not keep spinning a
    // "Contrôle final en cours" loader that hides the wait from the user.
    const needsInput: WorkspaceStateBucket = "needs_input";
    expect(
      deriveTaskTone(makeTask({ column: "done", validation: { state: "running" } }), needsInput),
    ).toBe("attention");
    expect(
      deriveTaskTone(makeTask({ column: "done", deployment: { state: "running" } }), needsInput),
    ).toBe("attention");
  });

  it("still spins the loader for a running action over a stale board flag", () => {
    // A board flag (a pending approval, a ready plan) can predate the action the
    // user just launched — it is NOT a live block. The running action must win
    // over it and show the working loader, so only a genuine live agent block
    // (permission / prose question) turns a running action amber.
    expect(
      deriveTaskTone(
        makeTask({
          column: "done",
          validation: { state: "running" },
          approval: { state: "pending" },
        }),
        undefined,
      ),
    ).toBe("running");
    expect(
      deriveTaskTone(
        makeTask({
          column: "done",
          validation: { state: "running" },
          planReadyAt: "2024-01-01T00:00:00.000Z",
        }),
        undefined,
      ),
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

  it("flips a running final check to amber when its agent asks a question mid-run", () => {
    // The final check is running, but the agent stopped to ask something in prose
    // (awaitsUser) with no further run in flight — exactly the reported bug where
    // a questionnaire stayed hidden behind a green "Contrôle final en cours". The
    // live block wins so the card goes amber and shakes for the answer.
    expect(
      deriveTaskTone(makeTask({ column: "done", validation: { state: "running" } }), "done", true),
    ).toBe("attention");
  });
});

describe("shouldShowVoyant — the corner pip carries read/unread, opacity never fades", () => {
  it("lights the green pip on a finished card the user has not opened yet", () => {
    expect(shouldShowVoyant(makeTask({ column: "done", viewedAt: null }), "done")).toBe(true);
  });

  it("drops the pip once a finished card has been opened (read)", () => {
    // The card stays at full opacity; only the green light goes away.
    expect(
      shouldShowVoyant(makeTask({ column: "done", viewedAt: "2026-07-24T11:00:00.000Z" }), "done"),
    ).toBe(false);
  });

  it("always shows the amber attention pip, even on an already-read card", () => {
    expect(
      shouldShowVoyant(
        makeTask({ column: "done", viewedAt: "2026-07-24T11:00:00.000Z" }),
        "attention",
      ),
    ).toBe(true);
  });

  it("always shows the running loader, even after the card was read", () => {
    // A finished card whose agent came back to life re-lights its live badge.
    expect(
      shouldShowVoyant(
        makeTask({ column: "in_progress", viewedAt: "2026-07-24T11:00:00.000Z" }),
        "running",
      ),
    ).toBe(true);
  });

  it("always shows the pending pip regardless of viewedAt", () => {
    expect(
      shouldShowVoyant(
        makeTask({ column: "in_progress", viewedAt: "2026-07-24T11:00:00.000Z" }),
        "pending",
      ),
    ).toBe(true);
  });

  it("shows the scheduled pip regardless of viewedAt", () => {
    expect(shouldShowVoyant(makeTask({ column: "scheduled", viewedAt: null }), "scheduled")).toBe(
      true,
    );
  });

  it("shows no pip when the card has no tone at all", () => {
    expect(shouldShowVoyant(makeTask({ column: "backlog", viewedAt: null }), null)).toBe(false);
  });
});
