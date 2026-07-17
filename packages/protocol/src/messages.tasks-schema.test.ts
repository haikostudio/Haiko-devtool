import { describe, expect, test } from "vitest";

import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";
import { KanbanTaskSchema, TaskBoardSchema } from "./tasks/types.js";

const board = {
  version: 1,
  projectId: "project-1",
  folders: [{ id: "f1", name: "Auth", order: 0, createdAt: "2026-07-16T00:00:00.000Z" }],
  tasks: [
    {
      id: "t1",
      folderId: "f1",
      title: "Add login form",
      tags: ["ui"],
      column: "backlog",
      order: 0,
      origin: "manual",
      normalizedTitle: "add login form",
      links: { agentIds: [] },
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
  ],
};

describe("tasks board schemas", () => {
  test("parses a minimal board", () => {
    expect(TaskBoardSchema.parse(board).tasks[0]?.column).toBe("backlog");
  });

  test("parses a fully-populated task (estimate, schedule, links)", () => {
    const task = KanbanTaskSchema.parse({
      ...board.tasks[0],
      column: "done",
      origin: "agent_sync",
      estimate: {
        tokens: 150000,
        quotaPercent: 12,
        confidence: "medium",
        model: "haiku",
        estimatedAt: "2026-07-16T01:00:00.000Z",
        summary: "Small UI change",
      },
      schedule: { state: "failed", attempts: 3, lastError: "no PR created" },
      links: {
        agentIds: ["agent-1"],
        primaryAgentId: "agent-1",
        workspaceId: "ws-1",
        branch: "task/t1-add-login-form",
        prUrl: "https://github.com/acme/repo/pull/12",
        prState: "open",
      },
      manualOverrideAt: "2026-07-16T02:00:00.000Z",
    });
    expect(task.links.prUrl).toBe("https://github.com/acme/repo/pull/12");
    expect(task.schedule?.state).toBe("failed");
  });

  test("routes tasks.* requests through the session inbound union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "tasks.task.move.request",
        requestId: "req-1",
        projectId: "project-1",
        taskId: "t1",
        column: "scheduled",
        index: 0,
      }),
    ).toMatchObject({ type: "tasks.task.move.request", column: "scheduled" });

    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "tasks.task.move.request",
        requestId: "req-1",
        projectId: "project-1",
        taskId: "t1",
        column: "not-a-column",
        index: 0,
      }),
    ).toThrow();
  });

  test("routes tasks.* responses and pushes through the session outbound union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "tasks.board.subscribe.response",
        payload: { requestId: "req-1", board, error: null },
      }),
    ).toMatchObject({ type: "tasks.board.subscribe.response" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "tasks.board.update",
        payload: { subscriptionId: "sub-1", projectId: "project-1", board },
      }),
    ).toMatchObject({ type: "tasks.board.update" });
  });

  test("accepts the tasksBoard server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: { tasksBoard: true },
      }).features,
    ).toEqual({ tasksBoard: true });
  });

  test("parses run config, approval, schedule preference, and duration fields", () => {
    const task = KanbanTaskSchema.parse({
      ...board.tasks[0],
      column: "scheduled",
      estimate: {
        tokens: 150000,
        quotaPercent: 12,
        estimatedMinutes: 30,
        confidence: "medium",
        model: "haiku",
        estimatedAt: "2026-07-16T01:00:00.000Z",
      },
      schedule: { state: "awaiting_slot", attempts: 0, waitingReason: "quiet_hours" },
      runConfig: {
        provider: "claude",
        model: "claude-opus-4-8",
        thinkingOptionId: "high",
        mode: "plan",
      },
      approval: { state: "pending", requestedBy: "agent-1", approvedAt: null },
      schedulePreference: "off_peak",
      planReadyAt: "2026-07-17T03:00:00.000Z",
    });
    expect(task.runConfig?.mode).toBe("plan");
    expect(task.approval?.state).toBe("pending");
    expect(task.estimate?.estimatedMinutes).toBe(30);
    expect(task.schedule?.waitingReason).toBe("quiet_hours");
    expect(task.schedulePreference).toBe("off_peak");
  });

  test("legacy tasks without the new fields still parse (both directions)", () => {
    // A board written by an old daemon must parse in a new client, and a board
    // with only legacy fields must parse in a new daemon.
    const parsed = TaskBoardSchema.parse(board);
    expect(parsed.tasks[0]?.runConfig ?? null).toBeNull();
    expect(parsed.tasks[0]?.approval ?? null).toBeNull();
    expect(parsed.tasks[0]?.schedulePreference).toBeUndefined();
  });

  test("routes tasks.task.approve.* through the session unions", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "tasks.task.approve.request",
        requestId: "req-1",
        projectId: "project-1",
        taskId: "t1",
      }),
    ).toMatchObject({ type: "tasks.task.approve.request" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "tasks.task.approve.response",
        payload: { requestId: "req-1", task: board.tasks[0], error: null },
      }),
    ).toMatchObject({ type: "tasks.task.approve.response" });
  });

  test("routes tasks.task.create.request with runConfig through the inbound union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "tasks.task.create.request",
        requestId: "req-1",
        projectId: "project-1",
        folderId: "f1",
        title: "Configured task",
        runConfig: { provider: "codex", model: "gpt-5.4" },
        schedulePreference: "asap",
      }),
    ).toMatchObject({ type: "tasks.task.create.request", schedulePreference: "asap" });
  });

  test("accepts the tasksRunConfig server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: { tasksRunConfig: true },
      }).features,
    ).toEqual({ tasksRunConfig: true });
  });
});
