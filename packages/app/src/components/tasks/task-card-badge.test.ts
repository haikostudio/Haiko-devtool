import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import { getPublishNotice, getScheduleBadge, offersDaemonRestart } from "./task-card-badge";

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
  it("shows an amber 'needs an action from you' badge when the live agent is blocked on the user", () => {
    // No board field explains the pause — the amber tone comes from the agent
    // blocking on a question/permission. This is the case the card used to miss.
    const badge = getScheduleBadge(makeTask(), "attention");
    expect(badge).toEqual({ labelKey: "tasks.card.needsAction", variant: "warning" });
  });

  it("shows « Plan prêt » while the card is parked at the plan-review step", () => {
    const badge = getScheduleBadge(
      makeTask({ column: "in_progress", planReadyAt: "2026-07-31T10:00:00.000Z" }),
      "attention",
    );
    expect(badge).toEqual({ labelKey: "tasks.card.planReady", variant: "success" });
  });

  it("drops a stale « Plan prêt » once the card is finished", () => {
    // The plan stamp is a "come review the plan" flag. A card that moved to
    // « Terminé » is no longer waiting on a plan — it must read « Terminé », never
    // a frozen « Plan prêt » left over from an earlier plan run.
    const badge = getScheduleBadge(
      makeTask({
        column: "done",
        planReadyAt: "2026-07-31T10:00:00.000Z",
        completedAt: "2026-07-31T10:30:00.000Z",
      }),
      "done",
    );
    expect(badge).toEqual({ labelKey: "tasks.card.finished", variant: "success" });
  });

  it("drops a stale « Plan prêt » once the work is published", () => {
    const badge = getScheduleBadge(
      makeTask({
        column: "deployed",
        planReadyAt: "2026-07-31T10:00:00.000Z",
        deployedAt: "2026-07-31T10:30:00.000Z",
      }),
      null,
    );
    expect(badge).toEqual({ labelKey: "tasks.card.deployed", variant: "success" });
  });

  it("says « Terminé » when nothing is expected from the user", () => {
    // The agent finished and went idle: no question, no running action. The card
    // must read as done instead of claiming it waits for a reply.
    const badge = getScheduleBadge(makeTask({ column: "done" }), "done");
    expect(badge).toEqual({ labelKey: "tasks.card.finished", variant: "success" });
  });

  it("says « Terminé » rather than a stale « En exécution » on an idle card", () => {
    // A finished run often leaves schedule.state === "running" behind; with an
    // idle agent (tone "done") the green "in progress" badge would be a lie.
    const badge = getScheduleBadge(
      makeTask({ column: "in_progress", schedule: { state: "running", attempts: 1 } }),
      "done",
    );
    expect(badge).toEqual({ labelKey: "tasks.card.finished", variant: "success" });
  });

  it("keeps the deploy window ahead of the « Terminé » badge", () => {
    expect(
      getScheduleBadge(makeTask({ column: "done", deployment: { state: "running" } }), "done"),
    ).toEqual({ labelKey: "tasks.card.deploying", variant: "success" });
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

  it("the needs-action badge wins over a stale 'running' schedule state", () => {
    // The agent asked a question mid-run: the schedule may still read "running",
    // but the amber tone (attention) must surface, not a green "in progress".
    const badge = getScheduleBadge(
      makeTask({ schedule: { state: "running", attempts: 1 } }),
      "attention",
    );
    expect(badge).toEqual({ labelKey: "tasks.card.needsAction", variant: "warning" });
  });

  it("shows the deploying badge the instant the deploy window opens, over a stale waiting badge", () => {
    // The user pressed "Lancer le déploiement": the server opened a running deploy
    // window, but the live bucket may still read attention until the agent streams.
    // The explicit action must win so the card says "Publication en cours".
    const badge = getScheduleBadge(makeTask({ deployment: { state: "running" } }), "attention");
    expect(badge).toEqual({ labelKey: "tasks.card.deploying", variant: "success" });
  });

  it("ignores a leftover final-check window: finishing a card runs nothing", () => {
    // Older daemons opened a check window on the card; the check is gone, so a card
    // still carrying one must read as a plain card, not as an action in flight.
    expect(getScheduleBadge(makeTask({ validation: { state: "running" } }), "attention")).toEqual({
      labelKey: "tasks.card.needsAction",
      variant: "warning",
    });
    expect(getScheduleBadge(makeTask({ validation: { state: "failed" } }), null)).toBeNull();
  });

  it("surfaces a failed deploy as an error badge", () => {
    expect(getScheduleBadge(makeTask({ deployment: { state: "failed" } }), null)).toEqual({
      labelKey: "tasks.card.deployFailed",
      variant: "error",
    });
  });

  it("shows the « Déployé » badge once the work is live via deployment state", () => {
    const badge = getScheduleBadge(makeTask({ deployment: { state: "deployed" } }), null);
    expect(badge).toEqual({ labelKey: "tasks.card.deployed", variant: "success" });
  });

  it("shows the « Déployé » badge once a deployedUrl is stamped", () => {
    const badge = getScheduleBadge(
      makeTask({ column: "done", deployedUrl: "https://etsigna.haikostudio.cloud" }),
      null,
    );
    expect(badge).toEqual({ labelKey: "tasks.card.deployed", variant: "success" });
  });

  it("keeps a running re-deploy spinner ahead of the deployed badge", () => {
    const badge = getScheduleBadge(
      makeTask({ deployment: { state: "running" }, deployedUrl: "https://x.haikostudio.cloud" }),
      "attention",
    );
    expect(badge).toEqual({ labelKey: "tasks.card.deploying", variant: "success" });
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

  it("never says « Analyse en cours » for a card already in « Planifié », even with a live agent", () => {
    // Analysis belongs to "Validé": a card is only promoted to "Planifié" once its
    // agent has released its analysis turn (the estimator waits for that). So a
    // running agent on a queued card means the launch is starting, and the badge
    // must read as launching — never fall back to an analysis label that
    // contradicts the column.
    const badge = getScheduleBadge(
      makeTask({
        column: "scheduled",
        schedule: { state: "awaiting_slot", attempts: 0 },
        estimate: { quotaPercent: 5, estimatedMinutes: 10 } as KanbanTask["estimate"],
      }),
      "running",
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

describe("getPublishNotice", () => {
  it("tells a finished card it will ship with the next publication", () => {
    // A publication builds the whole checkout, so a finished card rides it even
    // if nobody queued it. Announcing the departure is what makes it a decision.
    expect(getPublishNotice(makeTask({ column: "done" }))).toEqual({
      labelKey: "tasks.card.ridesNextPublish",
      variant: "success",
    });
    expect(getPublishNotice(makeTask({ column: "deployed" }))).toEqual({
      labelKey: "tasks.card.ridesNextPublish",
      variant: "success",
    });
  });

  it("says instead when the card was held out of the next batch", () => {
    expect(getPublishNotice(makeTask({ column: "done", deployHold: true }))).toEqual({
      labelKey: "tasks.card.publishHeld",
      variant: "warning",
    });
  });

  it("shows nothing on a card that is not finished", () => {
    expect(getPublishNotice(makeTask({ column: "in_progress" }))).toBeNull();
    expect(getPublishNotice(makeTask({ column: "backlog" }))).toBeNull();
  });

  it("drops the notice once the work is live", () => {
    // The truths that mean "published": the deploy stamp and the stamped URL.
    // The column is NOT one of them — "À déployer" is where a card waits.
    expect(
      getPublishNotice(makeTask({ column: "deployed", deployedAt: "2026-07-28T12:00:00.000Z" })),
    ).toBeNull();
    expect(
      getPublishNotice(makeTask({ column: "done", deployedUrl: "https://app.example.com" })),
    ).toBeNull();
  });
});

describe("offersDaemonRestart", () => {
  it("offers the restart once the work is live and needs one", () => {
    expect(
      offersDaemonRestart(
        makeTask({
          column: "deployed",
          needsDaemonRestart: true,
          deployedAt: "2026-07-28T12:00:00.000Z",
        }),
      ),
    ).toBe(true);
    // Queued but not published yet: restarting would prove nothing.
    expect(offersDaemonRestart(makeTask({ column: "deployed", needsDaemonRestart: true }))).toBe(
      false,
    );
    expect(
      offersDaemonRestart(
        makeTask({
          column: "done",
          needsDaemonRestart: true,
          deployedUrl: "https://app.example.com",
        }),
      ),
    ).toBe(true);
  });

  it("does not offer it before the work is published", () => {
    // Restarting for a change that is not online yet would prove nothing.
    expect(offersDaemonRestart(makeTask({ column: "done", needsDaemonRestart: true }))).toBe(false);
  });

  it("does not offer it for an app-only card", () => {
    expect(offersDaemonRestart(makeTask({ column: "deployed", needsDaemonRestart: false }))).toBe(
      false,
    );
    expect(offersDaemonRestart(makeTask({ column: "deployed" }))).toBe(false);
  });
});
