import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TaskBoard } from "@getpaseo/protocol/tasks/types";
import { TaskBoardStore } from "./store.js";
import { TaskBoardService, normalizeTaskTitle } from "./service.js";

const logger = pino({ level: "silent" });

describe("TaskBoardService", () => {
  let dir: string;
  let service: TaskBoardService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-tasks-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("normalizes titles for dedupe", () => {
    expect(normalizeTaskTitle("- [x] Fix the   Login form:")).toBe("fix the login form");
    expect(normalizeTaskTitle("1. Add tests!")).toBe("add tests");
  });

  test("creates folders and tasks, persists across store instances", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });

    const reloaded = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    const board = await reloaded.getBoard("proj-1");
    expect(board.folders).toHaveLength(1);
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]?.column).toBe("backlog");
  });

  test("getBoard fills blank billing fields of legacy estimates from the task", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Corriger la base active etsigna-dev",
      description: "Diagnostic et bascule sur la base de test.",
    });
    // Simulate an estimate persisted by a daemon that predated the billing
    // backfill: cost fields present, every billing field absent.
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      estimate: {
        tokens: 200_000,
        quotaPercent: 10,
        confidence: "low",
        model: "claude/haiku",
        estimatedAt: "2026-07-20T00:00:00.000Z",
      },
    }));

    // Read through a fresh service so nothing is served from an in-memory copy.
    const reloaded = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    const board = await reloaded.getBoard("proj-1");
    const estimate = board.tasks[0]?.estimate;
    expect(estimate?.billingTitle).toBe("Corriger la base active etsigna-dev");
    expect(estimate?.billingDescription).toBe("Diagnostic et bascule sur la base de test.");
    expect(estimate?.billingHours).toBeGreaterThan(0);
    // Non-destructive: the on-disk estimate keeps its blank billing.
    const rawStore = new TaskBoardStore(dir);
    const rawBoard = await rawStore.getBoard("proj-1");
    expect(rawBoard.tasks[0]?.estimate?.billingTitle).toBeUndefined();
  });

  test("supports remote project ids with slashes and colons", async () => {
    const projectId = "remote:github.com/haikostudio/brain";
    const folder = await service.createFolder(projectId, "Auth");
    await service.createTask(projectId, { folderId: folder.id, title: "Add login" });

    const reloaded = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    const board = await reloaded.getBoard(projectId);
    expect(board.projectId).toBe(projectId);
    expect(board.folders).toHaveLength(1);
    expect(board.tasks).toHaveLength(1);
  });

  test("moveTask re-packs orders and stamps manualOverrideAt on manual moves", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const a = await service.createTask("proj-1", { folderId: folder.id, title: "Task AAA long" });
    const b = await service.createTask("proj-1", { folderId: folder.id, title: "Task BBB long" });
    const c = await service.createTask("proj-1", { folderId: folder.id, title: "Task CCC long" });

    const board = await service.moveTask("proj-1", {
      taskId: c.id,
      column: "in_progress",
      index: 0,
      manual: true,
    });

    const find = (id: string) => board.tasks.find((task) => task.id === id);
    expect(find(c.id)?.column).toBe("in_progress");
    expect(find(c.id)?.order).toBe(0);
    expect(find(c.id)?.manualOverrideAt).toBeTruthy();
    expect(find(a.id)?.order).toBe(0);
    expect(find(b.id)?.order).toBe(1);
  });

  test("moving into scheduled sets pending_estimate and fires the estimate hook", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Big feature" });

    const board = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });

    expect(board.tasks[0]?.schedule?.state).toBe("pending_estimate");
    expect(scheduled).toEqual([task.id]);

    const back = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "backlog",
      index: 0,
      manual: true,
    });
    expect(back.tasks[0]?.schedule ?? null).toBeNull();
  });

  test("done is terminal: re-entering a pipeline column never re-arms a completed task", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Ship it now" });

    // Complete the task.
    const doneBoard = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "done",
      index: 0,
      manual: false,
    });
    expect(doneBoard.tasks[0]?.completedAt).toBeTruthy();
    const completedAt = doneBoard.tasks[0]?.completedAt;

    // Drag it back into the pipeline: it must NOT re-arm or notify the scheduler.
    const back = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });
    expect(back.tasks[0]?.column).toBe("scheduled");
    expect(back.tasks[0]?.schedule ?? null).toBeNull();
    expect(back.tasks[0]?.completedAt).toBe(completedAt);
    expect(scheduled).toEqual([]);
  });

  test("the deploy queue is terminal: entering it never stamps deployedAt nor re-arms", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Ship it live" });

    // Complete, then deploy the task.
    await service.moveTask("proj-1", { taskId: task.id, column: "done", index: 0, manual: false });
    const deployedBoard = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "deployed",
      index: 0,
      manual: true,
    });
    expect(deployedBoard.tasks[0]?.column).toBe("deployed");
    // Queued is not live: only a publication that succeeded stamps deployedAt.
    expect(deployedBoard.tasks[0]?.deployedAt ?? null).toBeNull();
    const live = await service.markTaskDeployed("proj-1", task.id, { url: "https://x" });
    expect(live.deployedAt).toBeTruthy();
    const deployedAt = live.deployedAt;

    // Drag it back into the pipeline: it must NOT re-arm or notify the scheduler.
    const back = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "validated",
      index: 0,
      manual: true,
    });
    expect(back.tasks[0]?.schedule ?? null).toBeNull();
    expect(back.tasks[0]?.deployedAt).toBe(deployedAt);
    expect(scheduled).toEqual([]);
  });

  test("every door into « Terminée » fires the completion listener", async () => {
    const completed: string[] = [];
    service.setOnTaskCompleted((_projectId, task) => {
      completed.push(task.id);
    });
    const folder = await service.createFolder("proj-1", "Auth");
    const dragged = await service.createTask("proj-1", { folderId: folder.id, title: "Drag me" });
    const transitioned = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Transition me",
    });

    // The user's drag / the agent's move_task — both land in moveTask.
    await service.moveTask("proj-1", {
      taskId: dragged.id,
      column: "done",
      index: 0,
      manual: true,
    });
    // The scheduler / agent-sync path.
    await service.transitionTask("proj-1", transitioned.id, "done");

    expect(completed.sort()).toEqual([dragged.id, transitioned.id].sort());

    // And it fires ONCE per card, not once per layer it went through.
    await service.moveTask("proj-1", {
      taskId: dragged.id,
      column: "done",
      index: 0,
      manual: true,
    });
    expect(completed.filter((id) => id === dragged.id)).toHaveLength(1);
  });

  test("moving straight to deployed backfills completedAt", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Hotfix live" });

    const board = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "deployed",
      index: 0,
      manual: true,
    });
    expect(board.tasks[0]?.deployedAt ?? null).toBeNull();
    expect(board.tasks[0]?.completedAt).toBeTruthy();
  });

  test('dragging a card back to "À faire" resets it to a draft', async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Login flow",
    });
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "validated",
      index: 0,
      manual: true,
    });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      estimate: {
        tokens: 1,
        quotaPercent: 5,
        estimatedMinutes: 10,
        confidence: "high",
        summary: "ok",
        model: "claude",
        estimatedAt: "2026-07-27T00:00:00.000Z",
      },
      analysis: {
        state: "failed",
        attempts: 3,
        failedAt: "2026-07-27T00:00:00.000Z",
        exhausted: true,
      },
      progress: "ready_for_review",
      planReadyAt: "2026-07-27T00:00:00.000Z",
      executionHold: true,
      validation: { state: "running", checkedAt: "2026-07-27T00:00:00.000Z" },
    }));

    const board = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "backlog",
      index: 0,
      manual: true,
    });
    const reset = board.tasks.find((entry) => entry.id === task.id);
    expect(reset?.estimate ?? null).toBeNull();
    expect(reset?.schedule ?? null).toBeNull();
    expect(reset?.analysis ?? null).toBeNull();
    expect(reset?.progress ?? null).toBeNull();
    expect(reset?.planReadyAt ?? null).toBeNull();
    expect(reset?.validation ?? null).toBeNull();
    expect(reset?.executionHold).not.toBe(true);
  });

  test("a reset keeps the card's agent: the work restarts, the history does not", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Login flow",
      agentId: "agent-1",
    });
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "validated",
      index: 0,
      manual: true,
    });

    const board = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "backlog",
      index: 0,
      manual: true,
    });
    const reset = board.tasks.find((entry) => entry.id === task.id);
    expect(reset?.links.agentIds).toContain("agent-1");
    expect(reset?.links.primaryAgentId).toBe("agent-1");
  });

  test("a reset keeps billing so the same work is never invoiced twice", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Login flow",
    });
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "validated",
      index: 0,
      manual: true,
    });
    await service.updateTask("proj-1", task.id, {
      billing: {
        kind: "invoice",
        documentId: "inv-1",
        number: "FA-2026-001",
        addedAt: "2026-07-27T00:00:00.000Z",
      },
    });

    const board = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "backlog",
      index: 0,
      manual: true,
    });
    expect(board.tasks.find((entry) => entry.id === task.id)?.billing?.documentId).toBe("inv-1");
  });

  test("upsertSyncedTask dedupes by normalized title project-wide", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const first = await service.upsertSyncedTask("proj-1", {
      folderId: folder.id,
      title: "Implement dark mode",
      agentId: "agent-1",
    });
    expect(first.created).toBe(true);

    const second = await service.upsertSyncedTask("proj-1", {
      folderId: folder.id,
      title: "- [ ] implement Dark Mode:",
      agentId: "agent-2",
    });
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.links.agentIds).toEqual(["agent-1", "agent-2"]);
    expect(second.task.links.primaryAgentId).toBe("agent-1");
  });

  test("subscribers receive board snapshots on every mutation", async () => {
    const snapshots: TaskBoard[] = [];
    const unsubscribe = service.subscribe("proj-1", (board) => snapshots.push(board));
    const folder = await service.createFolder("proj-1", "Auth");
    await service.createTask("proj-1", { folderId: folder.id, title: "Something real" });
    unsubscribe();
    await service.createFolder("proj-1", "UI");

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.tasks).toHaveLength(1);
  });

  test("a manual backlog task with a prompt fires light analysis, NOT the cost estimate", async () => {
    const scheduled: string[] = [];
    const refined: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    service.setOnBacklogRefine((_projectId, taskId) => refined.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");

    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Corrige le login",
      description: "il faut que le champ mot de passe prenne toute la largeur",
    });

    // Backlog: the light refiner runs; the expensive estimate hook never fires,
    // and the card carries no schedule/estimate.
    expect(task.column).toBe("backlog");
    expect(task.refinement).toBe("pending");
    expect(task.schedule ?? null).toBeNull();
    expect(task.estimate ?? null).toBeNull();
    expect(refined).toEqual([task.id]);
    expect(scheduled).toEqual([]);
  });

  test("a backlog task created from the '+' button (no prompt) is NOT light-analyzed", async () => {
    const refined: string[] = [];
    service.setOnBacklogRefine((_projectId, taskId) => refined.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");

    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Empty card" });

    expect(task.refinement ?? null).toBeNull();
    expect(refined).toEqual([]);
  });

  test("agent-proposed backlog tasks are not light-analyzed", async () => {
    const refined: string[] = [];
    service.setOnBacklogRefine((_projectId, taskId) => refined.push(taskId));
    const folder = await service.createFolder("proj-1", "Agent");

    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Idea from the agent",
      description: "some raw context",
      origin: "agent_sync",
    });

    expect(task.refinement ?? null).toBeNull();
    expect(refined).toEqual([]);
  });

  test("createTask honours an explicit inert column", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const note = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Idée en vrac",
      column: "notes",
    });
    // A card asked for in "Notes" stays in "Notes". Silently forcing every
    // creation into backlog made cards look like they jumped columns on their own.
    expect(note.column).toBe("notes");
  });

  test("createTask never lands in a pipeline column even when one is requested", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");

    // Callers may still pass a column, but creation is pinned to backlog — a task
    // only ever enters the pipeline through an explicit user move, never at birth.
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Proposed by agent",
      column: "scheduled",
    });

    expect(task.column).toBe("backlog");
    // Backlog is inert: no schedule armed, no estimate hook fired at creation.
    expect(task.schedule ?? null).toBeNull();
    expect(scheduled).toEqual([]);
  });

  test("createTask with launch remains inert in backlog", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");

    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Sent from the inline composer",
      launch: true,
    });

    // Creation never enters or arms the execution pipeline.
    expect(task.column).toBe("backlog");
    expect(task.schedule ?? null).toBeNull();
    expect(scheduled).toEqual([]);
  });

  test("createTask without launch leaves a backlog draft inert", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Auth");

    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Just a note for later",
    });

    expect(task.schedule ?? null).toBeNull();
    expect(scheduled).toEqual([]);
  });

  test("launch never overrides a pending approval (proposals stay inert)", async () => {
    const scheduled: string[] = [];
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));
    const folder = await service.createFolder("proj-1", "Agent");

    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Proposed, must wait for consent",
      launch: true,
      approval: { state: "pending", requestedBy: "agent-7" },
    });

    expect(task.schedule ?? null).toBeNull();
    expect(scheduled).toEqual([]);
  });

  test("agent proposals stay pending and fire onTaskProposed", async () => {
    const proposed: string[] = [];
    service.setOnTaskProposed((projectId) => proposed.push(projectId));
    const folder = await service.createFolder("proj-1", "Agent");

    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Traiter le mail client",
      runConfig: { provider: "claude", model: "claude-opus-4-8", mode: "plan" },
      approval: { state: "pending", requestedBy: "agent-42" },
    });

    // A proposal waits in backlog with its pending marker — inert until the user
    // validates it (no premature estimation in "À faire").
    expect(task.column).toBe("backlog");
    expect(task.schedule ?? null).toBeNull();
    expect(task.approval?.state).toBe("pending");
    expect(task.runConfig?.model).toBe("claude-opus-4-8");
    expect(proposed).toEqual(["proj-1"]);
  });

  test("approveTask moves a backlog proposal into validated and arms its schedule", async () => {
    const scheduled: string[] = [];
    const folder = await service.createFolder("proj-1", "Agent");
    // A proposal is born in backlog; approving is the user's consent to run it.
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Needs approval",
      approval: { state: "pending" },
    });
    expect(task.column).toBe("backlog");
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));

    const approved = await service.approveTask("proj-1", task.id);

    expect(approved.approval?.state).toBe("approved");
    expect(approved.approval?.approvedAt).toBeTruthy();
    // Approval lifts it out of backlog into the "Validé" consent gate and arms it.
    expect(approved.column).toBe("validated");
    expect(approved.schedule?.state).toBe("pending_estimate");
    expect(scheduled).toEqual([task.id]);
  });

  test("approveTask validates a plain backlog card (no proposal) and arms its schedule", async () => {
    const scheduled: string[] = [];
    const folder = await service.createFolder("proj-1", "Agent");
    // A normal manual card, no AI approval attached: the "Valider la tâche" bar
    // is the user's consent to admit it into the pipeline.
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Plain backlog card",
    });
    expect(task.column).toBe("backlog");
    expect(task.approval).toBeUndefined();
    service.setOnTaskScheduled((_projectId, taskId) => scheduled.push(taskId));

    const validated = await service.approveTask("proj-1", task.id);

    // It lands in the "Validé" consent gate with its analysis armed; no approval
    // record is invented for a card that never had one.
    expect(validated.column).toBe("validated");
    expect(validated.schedule?.state).toBe("pending_estimate");
    expect(validated.approval).toBeUndefined();
    expect(scheduled).toEqual([task.id]);
  });

  test("approveTask leaves a non-backlog, non-proposal card untouched", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Already scheduled",
    });
    // Drag it forward first, then a stray approve must be a no-op.
    await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });

    const result = await service.approveTask("proj-1", task.id);

    expect(result.column).toBe("scheduled");
  });

  test("archiveTask stamps archivedAt on a finished card without moving it", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Finished work",
    });
    await service.moveTask("proj-1", { taskId: task.id, column: "done", index: 0, manual: true });

    const archived = await service.archiveTask("proj-1", task.id, true);

    // Archiving only hides the card: it stays in "done" and gets an archivedAt.
    expect(archived.column).toBe("done");
    expect(archived.archivedAt).toBeTruthy();
  });

  test("archiveTask is a no-op on a card that is not done or deployed", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Still in backlog",
    });

    const result = await service.archiveTask("proj-1", task.id, true);

    expect(result.column).toBe("backlog");
    expect(result.archivedAt).toBeUndefined();
  });

  test("archiveTask with archived=false clears a prior archivedAt", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Toggle archive",
    });
    await service.moveTask("proj-1", { taskId: task.id, column: "done", index: 0, manual: true });
    const archived = await service.archiveTask("proj-1", task.id, true);
    expect(archived.archivedAt).toBeTruthy();

    const restored = await service.archiveTask("proj-1", task.id, false);

    expect(restored.archivedAt).toBeUndefined();
  });

  test("a manual drag into scheduled implicitly approves a pending proposal", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const task = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "Pending proposal",
      approval: { state: "pending", requestedBy: "agent-42" },
    });

    const board = await service.moveTask("proj-1", {
      taskId: task.id,
      column: "scheduled",
      index: 0,
      manual: true,
    });

    const moved = board.tasks.find((entry) => entry.id === task.id);
    expect(moved?.approval?.state).toBe("approved");
    expect(moved?.approval?.requestedBy).toBe("agent-42");
  });

  test("updateTask sets and clears runConfig and schedulePreference", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Configurable" });

    const withConfig = await service.updateTask("proj-1", task.id, {
      runConfig: { provider: "codex", model: "gpt-5.4", thinkingOptionId: "high" },
      schedulePreference: "off_peak",
    });
    expect(withConfig.runConfig?.provider).toBe("codex");
    expect(withConfig.schedulePreference).toBe("off_peak");

    const cleared = await service.updateTask("proj-1", task.id, {
      runConfig: null,
      schedulePreference: null,
    });
    expect(cleared.runConfig ?? null).toBeNull();
    expect(cleared.schedulePreference ?? null).toBeNull();
  });

  test("deleteFolder removes its tasks", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    await service.createTask("proj-1", { folderId: folder.id, title: "Doomed task here" });
    await service.deleteFolder("proj-1", folder.id);
    const board = await service.getBoard("proj-1");
    expect(board.folders).toHaveLength(0);
    expect(board.tasks).toHaveLength(0);
  });

  test("markTaskViewed stamps viewedAt once, idempotently, without reordering", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Seen me now" });
    const before = (await service.getBoard("proj-1")).tasks[0];
    expect(before?.viewedAt ?? null).toBeNull();

    const board = await service.markTaskViewed("proj-1", task.id);
    const viewed = board?.tasks.find((entry) => entry.id === task.id);
    expect(viewed?.viewedAt).toBeTruthy();
    // Marking viewed must never touch updatedAt (else the recency sort reshuffles).
    expect(viewed?.updatedAt).toBe(before?.updatedAt);

    // Idempotent: a second open returns null (nothing changed) and keeps the stamp.
    const again = await service.markTaskViewed("proj-1", task.id);
    expect(again).toBeNull();
    const stillViewed = (await service.getBoard("proj-1")).tasks.find(
      (entry) => entry.id === task.id,
    );
    expect(stillViewed?.viewedAt).toBe(viewed?.viewedAt);
  });

  test("promoteDoneTasksToDeployed moves only done cards on the merged branches", async () => {
    // "Auth" derives branch feat/auth; "Billing" derives feat/billing.
    const auth = await service.createFolder("proj-1", "Auth");
    const billing = await service.createFolder("proj-1", "Billing");
    const shipped = await service.createTask("proj-1", {
      folderId: auth.id,
      title: "Shipped auth work",
    });
    const otherDone = await service.createTask("proj-1", {
      folderId: billing.id,
      title: "Unrelated done work",
    });
    const stillOpen = await service.createTask("proj-1", {
      folderId: auth.id,
      title: "Auth work in flight",
    });
    await service.moveTask("proj-1", {
      taskId: shipped.id,
      column: "done",
      index: 0,
      manual: true,
    });
    await service.moveTask("proj-1", {
      taskId: otherDone.id,
      column: "done",
      index: 0,
      manual: true,
    });

    const moved = await service.promoteDoneTasksToDeployed({
      projectId: "proj-1",
      branches: new Set(["feat/auth"]),
    });
    expect(moved).toBe(1);

    const board = await service.getBoard("proj-1");
    const find = (id: string) => board.tasks.find((entry) => entry.id === id);
    // The done card on feat/auth is stamped live and filed straight into the
    // terminal "archived" column — its work shipped, so it leaves the queue.
    expect(find(shipped.id)?.column).toBe("archived");
    expect(find(shipped.id)?.deployedAt).toBeTruthy();
    // A done card on another branch is untouched; an in-flight card never moves.
    expect(find(otherDone.id)?.column).toBe("done");
    expect(find(stillOpen.id)?.column).toBe("backlog");
  });

  test("markTaskDeployed files a live card into the terminal « Archivé » column", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Ship it" });
    await service.moveTask("proj-1", { taskId: task.id, column: "done", index: 0, manual: false });
    await service.transitionTask("proj-1", task.id, "deployed");

    // Queued, not live: still in the publication column.
    let board = await service.getBoard("proj-1");
    expect(board.tasks.find((t) => t.id === task.id)?.column).toBe("deployed");

    const live = await service.markTaskDeployed("proj-1", task.id, { url: "https://x" });
    // Going live is the ONLY door into "archived" — automatic and one-way.
    expect(live.column).toBe("archived");
    expect(live.deployedAt).toBeTruthy();
    // A card archived this way is NOT hidden (archivedAt is the separate hide
    // marker): it stays visible in the read-only Archivé column.
    expect(live.archivedAt ?? null).toBeNull();

    board = await service.getBoard("proj-1");
    expect(board.tasks.find((t) => t.id === task.id)?.column).toBe("archived");
  });

  test("promoteDoneTasksToDeployed is a no-op when no branches were merged", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const done = await service.createTask("proj-1", { folderId: folder.id, title: "Done but ur" });
    await service.moveTask("proj-1", { taskId: done.id, column: "done", index: 0, manual: true });

    const moved = await service.promoteDoneTasksToDeployed({ projectId: "proj-1", branches: null });
    expect(moved).toBe(0);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === done.id)?.column).toBe("done");
  });

  test("settleRestartFlags clears published cards and leaves pending ones alone", async () => {
    const folder = await service.createFolder("proj-1", "Tâches");
    const live = await service.createTask("proj-1", { folderId: folder.id, title: "Livré" });
    const pending = await service.createTask("proj-1", {
      folderId: folder.id,
      title: "En attente",
    });
    await service.moveTask("proj-1", {
      taskId: live.id,
      column: "deployed",
      index: 0,
      manual: true,
    });
    // Live means the deploy stamp, not the column: "À déployer" is the queue.
    await service.markTaskDeployed("proj-1", live.id, { url: "https://app.example.com" });
    await service.moveTask("proj-1", {
      taskId: pending.id,
      column: "done",
      index: 0,
      manual: true,
    });
    await service.patchTask("proj-1", live.id, (task) => ({ ...task, needsDaemonRestart: true }));
    await service.patchTask("proj-1", pending.id, (task) => ({
      ...task,
      needsDaemonRestart: true,
    }));

    await service.settleRestartFlags("proj-1");

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((t) => t.id === live.id)?.needsDaemonRestart).toBe(false);
    // Still a forecast about the NEXT publication: this boot says nothing about it.
    expect(board.tasks.find((t) => t.id === pending.id)?.needsDaemonRestart).toBe(true);
  });

  test("legacy « Déployé » cards are stamped live once, so the queue starts empty", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    const legacy = await service.createTask("proj-1", { folderId: folder.id, title: "Ancienne" });
    await service.moveTask("proj-1", {
      taskId: legacy.id,
      column: "deployed",
      index: 0,
      manual: true,
    });

    expect(await service.backfillLegacyDeployedCards("proj-1")).toBe(1);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((t) => t.id === legacy.id)?.deployedAt).toBeTruthy();
    expect(board.legacyDeployedBackfilledAt).toBeTruthy();

    // Idempotent: a card queued AFTER the migration is never mistaken for
    // history, so the next batch really does publish it.
    const fresh = await service.createTask("proj-1", { folderId: folder.id, title: "Nouvelle" });
    await service.transitionTask("proj-1", fresh.id, "deployed");
    expect(await service.backfillLegacyDeployedCards("proj-1")).toBe(0);
    const after = await service.getBoard("proj-1");
    expect(after.tasks.find((t) => t.id === fresh.id)?.deployedAt ?? null).toBeNull();
  });

  test("the legacy migration never creates a board for a project that has none", async () => {
    await service.backfillLegacyDeployedCards("ghost-project");
    const boards = await readdir(dir).catch(() => [] as string[]);
    expect(boards.some((name) => name.includes("ghost-project"))).toBe(false);
  });

  test("settleRestartFlags never creates a board for a project that has none", async () => {
    // Boot runs this for EVERY known project; writing unconditionally would
    // create a board file (and push a board update) for projects with no cards.
    await service.settleRestartFlags("untouched-project");
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});
