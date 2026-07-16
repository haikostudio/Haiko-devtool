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
});
