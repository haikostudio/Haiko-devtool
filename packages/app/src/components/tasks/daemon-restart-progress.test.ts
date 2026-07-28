import { describe, expect, it } from "vitest";
import {
  describeRestartProgress,
  isRestartCancellable,
  RESTART_ARMING_MS,
  RESTART_EXPECTED_MS,
  RESTART_TIMEOUT_MS,
} from "./daemon-restart-progress";

const T0 = 500_000;

describe("describeRestartProgress", () => {
  it("is idle when no restart is under way", () => {
    expect(describeRestartProgress({ startedAtMs: null, nowMs: T0, reconnected: false })).toEqual({
      state: "idle",
    });
  });

  it("counts down from the full estimate on the first tick", () => {
    expect(describeRestartProgress({ startedAtMs: T0, nowMs: T0, reconnected: false })).toEqual({
      state: "counting",
      secondsLeft: 10,
    });
  });

  it("never shows 0 while it is still waiting", () => {
    // A countdown sitting on 0 reads as a stall; the last second must say "1 s".
    const result = describeRestartProgress({
      startedAtMs: T0,
      nowMs: T0 + RESTART_EXPECTED_MS - 1,
      reconnected: false,
    });
    expect(result).toEqual({ state: "counting", secondsLeft: 1 });
  });

  it("switches to a quiet 'reconnecting' once the estimate runs out", () => {
    expect(
      describeRestartProgress({
        startedAtMs: T0,
        nowMs: T0 + RESTART_EXPECTED_MS,
        reconnected: false,
      }),
    ).toEqual({ state: "reconnecting" });
  });

  it("gives up counting after the timeout", () => {
    expect(
      describeRestartProgress({
        startedAtMs: T0,
        nowMs: T0 + RESTART_TIMEOUT_MS,
        reconnected: false,
      }),
    ).toEqual({ state: "timeout" });
  });

  it("goes idle the moment the daemon is back, however early", () => {
    expect(
      describeRestartProgress({ startedAtMs: T0, nowMs: T0 + 3_000, reconnected: true }),
    ).toEqual({ state: "idle" });
  });

  it("ignores a clock that went backwards", () => {
    expect(
      describeRestartProgress({ startedAtMs: T0, nowMs: T0 - 5_000, reconnected: false }),
    ).toEqual({ state: "counting", secondsLeft: 10 });
  });

  it("opens an undo window before the request leaves", () => {
    const result = describeRestartProgress({
      armedAtMs: T0,
      startedAtMs: null,
      nowMs: T0 + 1_500,
      reconnected: false,
    });
    expect(result).toEqual({ state: "arming", secondsLeft: 4 });
    expect(isRestartCancellable(result)).toBe(true);
  });

  it("closes the undo window when the grace period runs out", () => {
    // The request is leaving now: offering "Annuler" past this point would be a
    // button that cannot keep its promise.
    const result = describeRestartProgress({
      armedAtMs: T0,
      startedAtMs: null,
      nowMs: T0 + RESTART_ARMING_MS,
      reconnected: false,
    });
    expect(result).toEqual({ state: "counting", secondsLeft: 10 });
    expect(isRestartCancellable(result)).toBe(false);
  });

  it("is not cancellable once the daemon is actually restarting", () => {
    const result = describeRestartProgress({
      armedAtMs: null,
      startedAtMs: T0,
      nowMs: T0 + 2_000,
      reconnected: false,
    });
    expect(isRestartCancellable(result)).toBe(false);
  });
});
