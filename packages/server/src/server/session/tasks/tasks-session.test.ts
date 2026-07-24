import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { TaskBoardService } from "../../tasks/service.js";
import { TaskBoardStore } from "../../tasks/store.js";
import { TasksSession } from "./tasks-session.js";

const logger = pino({ level: "silent" });

describe("TasksSession live board updates", () => {
  let dir: string;
  let service: TaskBoardService;
  let emitted: SessionOutboundMessage[];
  let session: TasksSession;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-tasks-session-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    emitted = [];
    session = new TasksSession({
      host: { emit: (msg) => emitted.push(msg) },
      taskBoardService: service,
      taskEstimator: null,
      taskScheduler: null,
      conductorService: null,
      logger,
    });
  });

  afterEach(async () => {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  function updatesFor(subscriptionId: string) {
    return emitted.filter(
      (msg) => msg.type === "tasks.board.update" && msg.payload.subscriptionId === subscriptionId,
    );
  }

  test("subscribe delivers the current board on the push channel", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    await service.createTask("proj-1", { folderId: folder.id, title: "Existing" });

    await session.handleBoardSubscribeRequest({
      type: "tasks.board.subscribe.request",
      requestId: "r1",
      projectId: "proj-1",
      subscriptionId: "sub-1",
    });

    const pushes = updatesFor("sub-1");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.type === "tasks.board.update" && pushes[0].payload.board.tasks).toHaveLength(
      1,
    );
  });

  test("a task created after subscribe is pushed live to the subscriber", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    await session.handleBoardSubscribeRequest({
      type: "tasks.board.subscribe.request",
      requestId: "r1",
      projectId: "proj-1",
      subscriptionId: "sub-1",
    });
    emitted.length = 0;

    // Simulate the conductor / inline-add path: any createTask broadcasts.
    await service.createTask("proj-1", { folderId: folder.id, title: "From conductor" });

    const pushes = updatesFor("sub-1");
    expect(pushes).toHaveLength(1);
    const board =
      pushes[0]?.type === "tasks.board.update" ? pushes[0].payload.board : { tasks: [] };
    expect(board.tasks.map((task) => task.title)).toContain("From conductor");
  });

  test("re-subscribing with the same id re-arms a single live listener", async () => {
    const folder = await service.createFolder("proj-1", "Agent");
    const subscribe = () =>
      session.handleBoardSubscribeRequest({
        type: "tasks.board.subscribe.request",
        requestId: "r1",
        projectId: "proj-1",
        subscriptionId: "sub-1",
      });

    await subscribe();
    // A reconnect re-sends the same subscription id; the stale listener must be
    // replaced, not duplicated, so the client receives exactly one push.
    await subscribe();
    emitted.length = 0;

    await service.createTask("proj-1", { folderId: folder.id, title: "Once" });

    expect(updatesFor("sub-1")).toHaveLength(1);
  });
});
