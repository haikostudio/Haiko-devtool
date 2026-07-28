import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import { resolveRunNowState } from "./task-run-now-state";

type Schedule = KanbanTask["schedule"];

describe("resolveRunNowState", () => {
  it("offers the plain launch action on a freshly queued card", () => {
    const state = resolveRunNowState({ state: "awaiting_slot", attempts: 0 }, false);
    expect(state).toEqual({ labelKey: "tasks.actions.runNow", busy: false, retry: false });
  });

  it("spins and refuses a second press as soon as the user has pressed once", () => {
    // The optimistic case: the daemon has not written "launching" yet, but the
    // control must already show the launch is under way instead of looking
    // untouched — that silence is what made the button feel stuck.
    const state = resolveRunNowState({ state: "awaiting_slot", attempts: 0 }, true);
    expect(state.busy).toBe(true);
    expect(state.labelKey).toBe("tasks.panel.runNowLaunching");
  });

  it("keeps spinning on the daemon's own launching state, with no local press", () => {
    const state = resolveRunNowState({ state: "launching", attempts: 1 }, false);
    expect(state).toEqual({ labelKey: "tasks.panel.runNowLaunching", busy: true, retry: false });
  });

  it("says the launch failed and stays pressable so the card can be re-armed", () => {
    // Attempts exhausted: the card will not move on its own again, and run-now is
    // the only way out — so the control must invite a retry, never go inert.
    const state = resolveRunNowState({ state: "failed", attempts: 3, lastError: "boom" }, false);
    expect(state).toEqual({ labelKey: "tasks.panel.runNowFailed", busy: false, retry: true });
  });

  it("a local press wins over a recorded failure, so a retry shows immediately", () => {
    const state = resolveRunNowState({ state: "failed", attempts: 3 }, true);
    expect(state.busy).toBe(true);
    expect(state.retry).toBe(false);
  });

  it("names the reason a queued card has not started yet", () => {
    const quota: Schedule = { state: "awaiting_slot", attempts: 0, waitingReason: "quota" };
    expect(resolveRunNowState(quota, false).labelKey).toBe("tasks.panel.runNowWaitingQuota");

    const window: Schedule = {
      state: "awaiting_slot",
      attempts: 0,
      waitingReason: "quiet_hours",
    };
    expect(resolveRunNowState(window, false).labelKey).toBe("tasks.panel.runNowWaitingWindow");
  });

  it("reports a pending analysis rather than promising a launch", () => {
    const state = resolveRunNowState({ state: "pending_estimate", attempts: 0 }, false);
    expect(state).toEqual({ labelKey: "tasks.panel.runNowEstimating", busy: false, retry: false });
  });

  it("falls back to the plain launch action when the card carries no schedule", () => {
    expect(resolveRunNowState(undefined, false).labelKey).toBe("tasks.actions.runNow");
    expect(resolveRunNowState(null, false).labelKey).toBe("tasks.actions.runNow");
  });
});
