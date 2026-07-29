import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AutoDeployWatcher } from "./auto-deploy.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

// 02:00 in Paris, inside the default 01:00 → 07:00 quiet window.
const OFF_PEAK_MS = Date.parse("2026-07-28T00:00:00.000Z");
// 14:00 in Paris — the middle of the working day.
const PEAK_MS = Date.parse("2026-07-28T12:00:00.000Z");
const QUIET_HOURS = { startHour: 1, endHour: 7, timeZone: "Europe/Paris" };

describe("AutoDeployWatcher", () => {
  let dir: string;
  let service: TaskBoardService;
  let deployed: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-auto-deploy-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    deployed = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedQueued(title: string): Promise<string> {
    const board = await service.getBoard("proj-1");
    const folder = board.folders[0] ?? (await service.createFolder("proj-1", "Tâches"));
    const task = await service.createTask("proj-1", { folderId: folder.id, title });
    await service.transitionTask("proj-1", task.id, "done");
    await service.transitionTask("proj-1", task.id, "deployed");
    return task.id;
  }

  function buildWatcher(input: { enabled: boolean; nowMs: number }) {
    return new AutoDeployWatcher({
      taskBoardService: service,
      taskBatchDeployer: {
        deployAll: async (projectId: string) => {
          deployed.push(projectId);
          return { started: true, queued: false, taskIds: [] };
        },
      },
      projectRegistry: {
        list: async () => [{ projectId: "proj-1", archivedAt: null }] as never,
      },
      getSettings: () => ({ enabled: input.enabled, quietHours: QUIET_HOURS }),
      now: () => input.nowMs,
      logger,
    });
  }

  test("publishes the waiting batch inside the quiet-hours window", async () => {
    await seedQueued("Login");

    await buildWatcher({ enabled: true, nowMs: OFF_PEAK_MS }).tick();

    expect(deployed).toEqual(["proj-1"]);
  });

  test("does nothing outside the window", async () => {
    await seedQueued("Login");

    await buildWatcher({ enabled: true, nowMs: PEAK_MS }).tick();

    expect(deployed).toEqual([]);
  });

  test("does nothing while the option is off — it is opt-in, restart included", async () => {
    await seedQueued("Login");

    await buildWatcher({ enabled: false, nowMs: OFF_PEAK_MS }).tick();

    expect(deployed).toEqual([]);
  });

  test("does not start a run when the queue is empty", async () => {
    await buildWatcher({ enabled: true, nowMs: OFF_PEAK_MS }).tick();

    expect(deployed).toEqual([]);
  });

  test("a card held back from the batch does not count as work to publish", async () => {
    const taskId = await seedQueued("Login");
    await service.updateTask("proj-1", taskId, { deployHold: true });

    await buildWatcher({ enabled: true, nowMs: OFF_PEAK_MS }).tick();

    expect(deployed).toEqual([]);
  });
});
