import { mkdtemp, rm } from "node:fs/promises";
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

  test("deleteFolder removes its tasks", async () => {
    const folder = await service.createFolder("proj-1", "Auth");
    await service.createTask("proj-1", { folderId: folder.id, title: "Doomed task here" });
    await service.deleteFolder("proj-1", folder.id);
    const board = await service.getBoard("proj-1");
    expect(board.folders).toHaveLength(0);
    expect(board.tasks).toHaveLength(0);
  });
});
