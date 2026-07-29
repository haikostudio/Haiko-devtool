import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { parseStartScriptDir, parseVhostHost } from "../../utils/project-dev-instance.js";
import { TaskPublisher } from "./publish-on-complete.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

describe("project dev instance parsing", () => {
  test("reads the checkout a launcher script runs in", () => {
    expect(parseStartScriptDir("export PORT=1\ncd '/root/etsigna-dev'\nexec npm run dev\n")).toBe(
      "/root/etsigna-dev",
    );
    expect(
      parseStartScriptDir("cd '/root/maestria' && if [ ! -d node_modules ]; then npm i; fi\n"),
    ).toBe("/root/maestria");
    expect(parseStartScriptDir("exec npm run dev\n")).toBeNull();
  });

  test("reads the hostname a Caddy vhost serves", () => {
    expect(parseVhostHost("etsigna-dev.haikostudio.cloud {\n\tencode gzip\n}\n")).toBe(
      "etsigna-dev.haikostudio.cloud",
    );
    expect(parseVhostHost("# comment\napp.haikostudio.cloud, www.x.cloud {\n")).toBe(
      "app.haikostudio.cloud",
    );
    expect(parseVhostHost(":8080 {\n")).toBeNull();
  });
});

describe("TaskPublisher", () => {
  let dir: string;
  let service: TaskBoardService;
  let notes: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-publish-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    notes = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedTask(): Promise<KanbanTask> {
    const folder = await service.createFolder("proj-1", "Auth");
    const task = await service.createTask("proj-1", { folderId: folder.id, title: "Add login" });
    return await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      links: { ...current.links, taskAgentId: "agent-7", branch: "task/add-login" },
    }));
  }

  function buildPublisher() {
    return new TaskPublisher({
      agentManager: {
        appendTimelineItem: async (_agentId: string, item: { type: string; text?: string }) => {
          notes.push(item.text ?? "");
        },
      } as never,
      logger,
      queueForDeployment: async (projectId, taskId) => {
        await service.transitionTask(projectId, taskId, "deployed");
      },
      clearQueueOnComplete: async (projectId, taskId) => {
        await service.patchTask(projectId, taskId, (current) => ({
          ...current,
          queueOnComplete: false,
        }));
      },
    });
  }

  test("a finished card rests in Terminé — it is NOT queued for deployment", async () => {
    const task = await seedTask();
    const board = await service.transitionTask("proj-1", task.id, "done");
    const done = board.tasks.find((item) => item.id === task.id);
    if (!done) throw new Error("task lost");

    await buildPublisher().announceReady("proj-1", done);

    const after = await service.getBoard("proj-1");
    const resting = after.tasks.find((entry) => entry.id === task.id);
    // The card stops in "done": entering "deployed" is a manual user press.
    expect(resting?.column).toBe("done");
    expect(resting?.deployedAt ?? null).toBeNull();
    expect(resting?.deployedUrl ?? null).toBeNull();
    expect(notes.at(-1)).toContain("Terminé");
  });

  test("a card already in the queue is left alone", async () => {
    const task = await seedTask();
    await service.transitionTask("proj-1", task.id, "done");
    await service.transitionTask("proj-1", task.id, "deployed");
    const board = await service.getBoard("proj-1");
    const queued = board.tasks.find((entry) => entry.id === task.id);
    if (!queued) throw new Error("task lost");

    await buildPublisher().announceReady("proj-1", queued);

    expect(notes).toHaveLength(0);
  });

  test("a card armed with « Terminer et mettre en file » continues into the queue", async () => {
    const task = await seedTask();
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      queueOnComplete: true,
    }));
    const board = await service.transitionTask("proj-1", task.id, "done");
    const done = board.tasks.find((item) => item.id === task.id);
    if (!done) throw new Error("task lost");

    await buildPublisher().announceReady("proj-1", done);

    const after = await service.getBoard("proj-1");
    const queued = after.tasks.find((entry) => entry.id === task.id);
    expect(queued?.column).toBe("deployed");
    // Queued is not live, and the one-shot flag is spent so the next run of this
    // card starts from the default "stop in Terminé" behaviour.
    expect(queued?.deployedAt ?? null).toBeNull();
    expect(queued?.queueOnComplete).toBe(false);
    expect(notes.at(-1)).toContain("mis en file");
  });
});
