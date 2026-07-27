import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { parseStartScriptDir, parseVhostHost } from "../../utils/project-dev-instance.js";
import { type DeployRunSnapshot, TaskPublisher } from "./publish-on-complete.js";
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
  let triggered: { projectId: string; mergeBranches: string[] }[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-task-publish-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    notes = [];
    triggered = [];
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

  function buildPublisher(input: {
    isSelfHost: boolean;
    url: string | null;
    runs?: DeployRunSnapshot[];
    started?: boolean;
  }) {
    const runs = [...(input.runs ?? [])];
    return new TaskPublisher({
      taskBoardService: service,
      projectRegistry: { get: async () => ({ projectId: "proj-1", rootPath: "/root/x" }) as never },
      agentManager: {
        appendTimelineItem: async (_agentId: string, item: { type: string; text?: string }) => {
          notes.push(item.text ?? "");
        },
      } as never,
      isSelfHostRoot: () => input.isSelfHost,
      resolveProjectUrl: async () => input.url,
      triggerDeploy: async (trigger) => {
        triggered.push(trigger);
        return { started: input.started ?? true, error: "déjà en cours" };
      },
      readDeployRun: async () =>
        runs.shift() ?? { deploying: false, phase: null, outcome: null, error: null },
      sleep: async () => {},
      logger,
    });
  }

  test("an ordinary project only records where its work went live", async () => {
    const task = await seedTask();
    const publisher = buildPublisher({
      isSelfHost: false,
      url: "https://etsigna-dev.haikostudio.cloud",
    });

    await publisher.handleCompleted("proj-1", task);

    // The agent already deployed it during the check — no daemon publish here.
    expect(triggered).toHaveLength(0);
    expect(notes).toHaveLength(0);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.deployedUrl).toBe(
      "https://etsigna-dev.haikostudio.cloud",
    );
  });

  test("a Paseo card publishes, narrates its phases and links the live address", async () => {
    const task = await seedTask();
    const publisher = buildPublisher({
      isSelfHost: true,
      url: "https://app.haikostudio.cloud",
      runs: [
        { deploying: true, phase: "build", outcome: null, error: null },
        { deploying: true, phase: "publish", outcome: null, error: null },
        { deploying: false, phase: "done", outcome: "success", error: null },
      ],
    });

    await publisher.handleCompleted("proj-1", task);

    expect(triggered).toEqual([{ projectId: "proj-1", mergeBranches: ["task/add-login"] }]);
    expect(notes[0]).toContain("mise en ligne de cette tâche en cours");
    expect(notes.join("\n")).toContain("Construction de l'application");
    expect(notes.join("\n")).toContain("Mise en ligne…");
    expect(notes.at(-1)).toContain("https://app.haikostudio.cloud");
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.deployedUrl).toBe(
      "https://app.haikostudio.cloud",
    );
  });

  test("a failed publish says so instead of claiming the card is live", async () => {
    const task = await seedTask();
    const publisher = buildPublisher({
      isSelfHost: true,
      url: "https://app.haikostudio.cloud",
      runs: [{ deploying: false, phase: "error", outcome: "failed", error: "build cassé" }],
    });

    await publisher.handleCompleted("proj-1", task);

    expect(notes.at(-1)).toContain("build cassé");
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === task.id)?.deployedUrl ?? null).toBeNull();
  });

  test("a publish that never starts is reported, not swallowed", async () => {
    const task = await seedTask();
    const publisher = buildPublisher({
      isSelfHost: true,
      url: "https://app.haikostudio.cloud",
      started: false,
    });

    await publisher.handleCompleted("proj-1", task);

    expect(notes.at(-1)).toContain("déjà en cours");
  });
});
