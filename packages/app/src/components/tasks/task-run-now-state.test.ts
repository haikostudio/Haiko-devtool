import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import { resolveRunNowState } from "./task-run-now-state";

type Schedule = KanbanTask["schedule"];

describe("resolveRunNowState", () => {
  it("offers the plain launch action on a freshly queued card", () => {
    const state = resolveRunNowState({ state: "awaiting_slot", attempts: 0 }, false);
    expect(state).toEqual({
      labelKey: "tasks.actions.runNow",
      busy: false,
      disabled: false,
      retry: false,
    });
  });

  it("spins and refuses a second press as soon as the user has pressed once", () => {
    // The optimistic case: the daemon has not written "launching" yet, but the
    // control must already show the launch is under way instead of looking
    // untouched — that silence is what made the button feel stuck.
    const state = resolveRunNowState({ state: "awaiting_slot", attempts: 0 }, true);
    expect(state.busy).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.labelKey).toBe("tasks.panel.runNowLaunching");
  });

  it("keeps spinning on the daemon's own launching state, with no local press", () => {
    const state = resolveRunNowState({ state: "launching", attempts: 1 }, false);
    expect(state.busy).toBe(true);
    expect(state.labelKey).toBe("tasks.panel.runNowLaunching");
  });

  it("NEVER latches off on a daemon 'launching' state — a stalled launch stays pressable", () => {
    // The regression that matters. A launch can die mid-flight (daemon restarted
    // between reserving the slot and spawning the agent), leaving the card frozen
    // at "launching" forever. Re-pressing run-now is exactly what re-arms it
    // server-side, so disabling the control here would lock the only cure behind
    // the disease — the original stuck button, rebuilt.
    const state = resolveRunNowState({ state: "launching", attempts: 1 }, false);
    expect(state.disabled).toBe(false);
  });

  it("says the launch failed and stays pressable so the card can be re-armed", () => {
    // Attempts exhausted: the card will not move on its own again, and run-now is
    // the only way out — so the control must invite a retry, never go inert.
    const state = resolveRunNowState({ state: "failed", attempts: 3, lastError: "boom" }, false);
    expect(state).toEqual({
      labelKey: "tasks.panel.runNowFailed",
      busy: false,
      disabled: false,
      retry: true,
    });
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
    expect(state).toEqual({
      labelKey: "tasks.panel.runNowEstimating",
      busy: false,
      disabled: false,
      retry: false,
    });
  });

  it("falls back to the plain launch action when the card carries no schedule", () => {
    expect(resolveRunNowState(undefined, false).labelKey).toBe("tasks.actions.runNow");
    expect(resolveRunNowState(null, false).labelKey).toBe("tasks.actions.runNow");
  });

  it("only ever refuses a press while the local optimistic window is open", () => {
    // The safety invariant, stated once over every reachable schedule state: the
    // ONLY thing that may disable this control is the local press flag, which
    // clears itself. No daemon state can latch it off.
    const schedules: Schedule[] = [
      undefined,
      null,
      { state: "pending_estimate", attempts: 0 },
      { state: "awaiting_slot", attempts: 0 },
      { state: "awaiting_slot", attempts: 0, waitingReason: "quota" },
      { state: "awaiting_slot", attempts: 0, waitingReason: "quiet_hours" },
      { state: "launching", attempts: 1 },
      { state: "running", attempts: 1 },
      { state: "failed", attempts: 3, lastError: "boom" },
    ];
    for (const schedule of schedules) {
      expect(resolveRunNowState(schedule, false).disabled).toBe(false);
      expect(resolveRunNowState(schedule, true).disabled).toBe(true);
    }
  });
});
