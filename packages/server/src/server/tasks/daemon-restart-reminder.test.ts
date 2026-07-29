import { describe, expect, it } from "vitest";
import {
  decideRestartReminder,
  describeStaleDaemonBuild,
  NO_RESTART_DEBT,
  type RestartReminderState,
} from "./daemon-restart-reminder.js";

const GRACE = 2 * 60 * 60 * 1000;
const T0 = 1_000_000;

function debtAt(headSha: string, commitCount = 1) {
  return { commitCount, headSha };
}

describe("decideRestartReminder", () => {
  it("says nothing the first time a debt is seen — it starts the clock", () => {
    const result = decideRestartReminder({
      debt: debtAt("abc"),
      state: NO_RESTART_DEBT,
      nowMs: T0,
      graceMs: GRACE,
    });
    expect(result.notify).toBeNull();
    expect(result.state).toEqual({ debtSha: "abc", debtSinceMs: T0, notified: false });
  });

  it("stays quiet inside the grace period", () => {
    const state: RestartReminderState = { debtSha: "abc", debtSinceMs: T0, notified: false };
    const result = decideRestartReminder({
      debt: debtAt("abc"),
      state,
      nowMs: T0 + GRACE - 1,
      graceMs: GRACE,
    });
    expect(result.notify).toBeNull();
  });

  it("nudges once the work has been dormant for the whole grace period", () => {
    const state: RestartReminderState = { debtSha: "abc", debtSinceMs: T0, notified: false };
    const result = decideRestartReminder({
      debt: debtAt("abc", 3),
      state,
      nowMs: T0 + GRACE,
      graceMs: GRACE,
    });
    expect(result.notify).toEqual({ commitCount: 3, headSha: "abc" });
    expect(result.state.notified).toBe(true);
  });

  it("never nudges twice for the same publication", () => {
    const state: RestartReminderState = { debtSha: "abc", debtSinceMs: T0, notified: true };
    const result = decideRestartReminder({
      debt: debtAt("abc"),
      state,
      nowMs: T0 + 10 * GRACE,
      graceMs: GRACE,
    });
    expect(result.notify).toBeNull();
    expect(result.state).toEqual(state);
  });

  it("restarts the clock when fresh work lands on top", () => {
    // A new HEAD is a new publication: it deserves its own countdown rather than
    // inheriting the previous one's (which would fire instantly).
    const state: RestartReminderState = { debtSha: "abc", debtSinceMs: T0, notified: true };
    const result = decideRestartReminder({
      debt: debtAt("def"),
      state,
      nowMs: T0 + 10 * GRACE,
      graceMs: GRACE,
    });
    expect(result.notify).toBeNull();
    expect(result.state).toEqual({
      debtSha: "def",
      debtSinceMs: T0 + 10 * GRACE,
      notified: false,
    });
  });

  it("forgets everything once the daemon runs current code", () => {
    // The restart happened: the next publication must get its own reminder.
    const state: RestartReminderState = { debtSha: "abc", debtSinceMs: T0, notified: true };
    const result = decideRestartReminder({
      debt: { commitCount: 0, headSha: "abc" },
      state,
      nowMs: T0 + GRACE,
      graceMs: GRACE,
    });
    expect(result.notify).toBeNull();
    expect(result.state).toEqual(NO_RESTART_DEBT);
  });

  it("stays silent when the debt cannot be read", () => {
    const result = decideRestartReminder({
      debt: { commitCount: 2, headSha: null },
      state: NO_RESTART_DEBT,
      nowMs: T0,
      graceMs: GRACE,
    });
    expect(result.notify).toBeNull();
  });
});

describe("describeStaleDaemonBuild", () => {
  it("raises the alarm when the engine runs a build older than what is published", () => {
    // The exact trap: the publication succeeded, the daemon restarted, and the
    // code it reloaded was compiled from an earlier commit.
    const message = describeStaleDaemonBuild({
      builtSha: "1111111111",
      deployedSha: "2222222222",
      servedSha: "2222222222",
      stale: true,
      siteMismatch: false,
    });
    expect(message).toContain("11111111");
    expect(message).toContain("22222222");
  });

  it("says nothing when the engine runs the published build", () => {
    expect(
      describeStaleDaemonBuild({
        builtSha: "abc",
        deployedSha: "abc",
        servedSha: "abc",
        stale: false,
        siteMismatch: false,
      }),
    ).toBeNull();
  });

  it("says nothing when the answer is unknown", () => {
    // No marker (old install, dev run from source): an unknown answer must never
    // be dressed up as a diagnosis.
    expect(
      describeStaleDaemonBuild({
        builtSha: null,
        deployedSha: "abc",
        servedSha: null,
        stale: false,
        siteMismatch: false,
      }),
    ).toBeNull();
  });

  it("also raises the alarm when the served site is not the published version", () => {
    // The other half: the engine may be right while the site serves an older
    // bundle (or announces a version it does not carry).
    const message = describeStaleDaemonBuild({
      builtSha: "2222222222",
      deployedSha: "2222222222",
      servedSha: "3333333333",
      stale: false,
      siteMismatch: true,
    });
    expect(message).toContain("33333333");
    expect(message).toContain("22222222");
  });
});
