import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import {
  TaskBatchDeployer,
  selectPendingDeployTasks,
  selectQueuedDeployTasks,
  type DeployRunSnapshot,
} from "./batch-deployer.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

describe("selectPendingDeployTasks", () => {
  function task(overrides: Partial<KanbanTask>): KanbanTask {
    return {
      id: "t",
      folderId: "f",
      title: "T",
      tags: [],
      column: "deployed",
      order: 0,
      origin: "user",
      normalizedTitle: "t",
      links: { agentIds: [] },
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
      ...overrides,
    } as KanbanTask;
  }

  test("sweeps every finished card and drops the ones already live", () => {
    const pending = selectPendingDeployTasks([
      task({ id: "queued" }),
      task({ id: "live-stamp", deployedAt: "2026-07-28T11:00:00.000Z" }),
      task({ id: "live-url", deployedUrl: "https://x" }),
      task({ id: "live-window", deployment: { state: "deployed" } }),
      task({ id: "archived", archivedAt: "2026-07-28T11:00:00.000Z" }),
      task({ id: "still-running", column: "in_progress" }),
      // Resting in "Terminé": the build carries its work whether it was queued or
      // not, so the run takes it in rather than shipping it invisibly.
      task({ id: "just-done", column: "done" }),
      // "Retirer du prochain lot": still on the board, skipped by the batch.
      task({ id: "held", deployHold: true }),
    ]);
    expect(pending.map((entry) => entry.id)).toEqual(["queued", "just-done"]);
  });

  test("only the queued cards order an off-peak publication", () => {
    const queued = selectQueuedDeployTasks([
      task({ id: "queued" }),
      task({ id: "just-done", column: "done" }),
    ]);
    expect(queued.map((entry) => entry.id)).toEqual(["queued"]);
  });
});

describe("TaskBatchDeployer", () => {
  let dir: string;
  let service: TaskBoardService;
  let notes: string[];
  let triggered: { projectId: string; mergeBranches: string[] }[];
  let restarts: string[];
  let perCard: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-batch-deploy-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
    notes = [];
    triggered = [];
    restarts = [];
    perCard = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A finished card sitting in the "À déployer" queue, agent + branch linked. */
  async function seedQueued(title: string, branch: string): Promise<KanbanTask> {
    const board = await service.getBoard("proj-1");
    const folder = board.folders[0] ?? (await service.createFolder("proj-1", "Tâches"));
    const task = await service.createTask("proj-1", { folderId: folder.id, title });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      links: { ...current.links, taskAgentId: `agent-${task.id}`, branch },
    }));
    await service.transitionTask("proj-1", task.id, "done");
    await service.transitionTask("proj-1", task.id, "deployed");
    const latest = await service.getBoard("proj-1");
    const queued = latest.tasks.find((entry) => entry.id === task.id);
    if (!queued) throw new Error("task lost");
    return queued;
  }

  /** A finished card the user left resting in "Terminé", never queued. */
  async function seedFinished(title: string, branch: string): Promise<KanbanTask> {
    const board = await service.getBoard("proj-1");
    const folder = board.folders[0] ?? (await service.createFolder("proj-1", "Tâches"));
    const task = await service.createTask("proj-1", { folderId: folder.id, title });
    await service.patchTask("proj-1", task.id, (current) => ({
      ...current,
      links: { ...current.links, taskAgentId: `agent-${task.id}`, branch },
    }));
    await service.transitionTask("proj-1", task.id, "done");
    const latest = await service.getBoard("proj-1");
    const finished = latest.tasks.find((entry) => entry.id === task.id);
    if (!finished) throw new Error("task lost");
    return finished;
  }

  function buildDeployer(input: {
    isSelfHost?: boolean;
    url?: string | null;
    runs?: DeployRunSnapshot[];
    started?: boolean;
    agentId?: string | null;
    awaitDeployAgentIdle?: (agentId: string) => Promise<void>;
    /** Blocks each triggerDeploy until resolved — holds a run active on purpose. */
    holdTrigger?: Promise<void>;
  }) {
    const runs = [...(input.runs ?? [])];
    // Bind the collectors NOW, so a run still finishing when its test ends keeps
    // writing into that test's arrays instead of the next test's fresh ones. A
    // publication ends with a restart request, and a leaked one used to surface
    // as a phantom restart in an unrelated test.
    const runNotes = notes;
    const runTriggered = triggered;
    const runRestarts = restarts;
    const runPerCard = perCard;
    return new TaskBatchDeployer({
      taskBoardService: service,
      projectRegistry: { get: async () => ({ projectId: "proj-1", rootPath: "/root/x" }) as never },
      agentManager: {
        appendTimelineItem: async (_agentId: string, item: { type: string; text?: string }) => {
          runNotes.push(item.text ?? "");
        },
      } as never,
      isSelfHostRoot: () => input.isSelfHost !== false,
      resolveProjectUrl: async () => input.url ?? null,
      triggerDeploy: async (trigger) => {
        runTriggered.push(trigger);
        if (input.holdTrigger) {
          await input.holdTrigger;
        }
        return {
          started: input.started ?? true,
          error: "déjà en cours",
          agentId: input.agentId ?? null,
        };
      },
      readDeployRun: async () =>
        runs.shift() ?? { deploying: false, phase: null, outcome: null, error: null },
      deployTask: async (_projectId, taskId) => {
        runPerCard.push(taskId);
      },
      requestDaemonRestart: (reason) => runRestarts.push(reason),
      awaitDeployAgentIdle: input.awaitDeployAgentIdle,
      sleep: async () => {},
      logger,
    });
  }

  /** Lets the fire-and-forget run finish before assertions read the board. */
  async function settle(check?: () => boolean | Promise<boolean>): Promise<void> {
    for (let index = 0; index < 200; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (await check?.()) {
        return;
      }
    }
  }

  /** True once any note posted so far contains the given fragment. */
  function noteContains(fragment: string): boolean {
    return notes.some((note) => note.includes(fragment));
  }

  async function taskIsLive(taskId: string): Promise<boolean> {
    const board = await service.getBoard("proj-1");
    return board.tasks.some((task) => task.id === taskId && Boolean(task.deployedAt));
  }

  test("publishes the whole queue in one run, stamps the cards and restarts the engine", async () => {
    const first = await seedQueued("Login", "task/login");
    const second = await seedQueued("Signup", "task/signup");
    await service.patchTask("proj-1", first.id, (current) => ({
      ...current,
      needsDaemonRestart: true,
    }));
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [
        { deploying: true, phase: "daemon", outcome: null, error: null },
        { deploying: false, phase: "done", outcome: "success", error: null },
      ],
    });

    const result = await deployer.deployAll("proj-1");
    expect(result).toEqual({ started: true, queued: false, taskIds: [first.id, second.id] });
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");

    // ONE publication for the whole batch. Tasks run in place on main, so there
    // are no per-task branches to merge — the deploy just builds main.
    expect(triggered).toEqual([{ projectId: "proj-1", mergeBranches: [] }]);
    const board = await service.getBoard("proj-1");
    for (const id of [first.id, second.id]) {
      const card = board.tasks.find((entry) => entry.id === id);
      expect(card?.deployedAt).toBeTruthy();
      expect(card?.deployedUrl).toBe("https://app.haikostudio.cloud");
      expect(card?.deployment?.state).toBe("deployed");
    }
    expect(notes.join("\n")).toContain("Construction du moteur");
    expect(restarts).toEqual(["task_batch_deploy"]);
    // The board carries the run, so the column can show one progress bar and
    // then the "voici ce qui vient d'être mis en ligne" recap.
    expect(board.deployBatch?.state).toBe("success");
    expect(board.deployBatch?.taskIds).toEqual([first.id, second.id]);
    expect(board.deployBatch?.titles).toEqual(["Login", "Signup"]);
    expect(board.deployBatch?.url).toBe("https://app.haikostudio.cloud");
    expect(board.deployBatch?.finishedAt).toBeTruthy();
  });

  test("stamps the cards but holds the restart until the deploy agent has finished", async () => {
    const card = await seedQueued("Login", "task/login");
    await service.patchTask("proj-1", card.id, (current) => ({
      ...current,
      needsDaemonRestart: true,
    }));
    let releaseAgent: (() => void) | null = null;
    const idleCalls: string[] = [];
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      agentId: "deploy-agent-1",
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
      awaitDeployAgentIdle: (agentId) => {
        idleCalls.push(agentId);
        return new Promise<void>((resolve) => {
          releaseAgent = resolve;
        });
      },
    });

    await deployer.deployAll("proj-1");
    // The "c'est en ligne" note is posted right after the cards are stamped and
    // just before succeed() blocks on the agent's rest — a reliable midway marker.
    await settle(() => noteContains("en ligne"));

    // The publication is live and the card is already stamped, but the shared
    // progress stays open until the agent has written its verdict and the final
    // restart has been requested.
    expect(idleCalls).toEqual(["deploy-agent-1"]);
    const midway = await service.getBoard("proj-1");
    expect(midway.tasks.find((entry) => entry.id === card.id)?.deployedAt).toBeTruthy();
    expect(midway.deployBatch?.state).toBe("running");
    expect(restarts).toEqual([]);

    // The agent reaches rest → now, and only now, the restart fires.
    releaseAgent?.();
    await settle(() => restarts.length > 0);
    expect(restarts).toEqual(["task_batch_deploy"]);
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");
  });

  test("a held-back card is left out of the run", async () => {
    const shipped = await seedQueued("Login", "task/login");
    const held = await seedQueued("Signup", "task/signup");
    await service.updateTask("proj-1", held.id, { deployHold: true });
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
    });

    const result = await deployer.deployAll("proj-1");
    expect(result.taskIds).toEqual([shipped.id]);
    // Settle on the run's terminal state, not just on the card: a publication
    // keeps writing (recap, restart) after the first card goes live, and leaving
    // that tail running raced this test's own temp directory teardown.
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === shipped.id)?.deployedAt).toBeTruthy();
    expect(board.tasks.find((entry) => entry.id === held.id)?.deployedAt ?? null).toBeNull();
  });

  test("a failed publication marks nothing live and says why", async () => {
    const task = await seedQueued("Login", "task/login");
    const deployer = buildDeployer({
      runs: [{ deploying: false, phase: "error", outcome: "failed", error: "build cassé" }],
    });

    await deployer.deployAll("proj-1");
    await settle();

    const board = await service.getBoard("proj-1");
    const card = board.tasks.find((entry) => entry.id === task.id);
    expect(card?.deployedAt ?? null).toBeNull();
    expect(card?.deployment?.state).toBe("failed");
    expect(notes.join("\n")).toContain("build cassé");
    // The engine is only ever restarted after a publication that succeeded.
    expect(restarts).toEqual([]);
    expect(board.deployBatch?.state).toBe("failed");
    expect(board.deployBatch?.error).toContain("build cassé");
  });

  test("keeps progress open when the deploy agent pauses without a live verdict", async () => {
    const task = await seedQueued("Login", "task/login");
    const deployer = buildDeployer({
      agentId: "deploy-agent-1",
      // The run pauses once, then resumes and reaches a verified live outcome.
      runs: [
        { deploying: true, phase: "build", outcome: null, error: null },
        { deploying: true, phase: "build", outcome: null, error: null },
        { deploying: false, phase: "done", outcome: "success", error: null },
      ],
      awaitDeployAgentIdle: async () => {},
    });

    await deployer.deployAll("proj-1");
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");

    const board = await service.getBoard("proj-1");
    const card = board.tasks.find((entry) => entry.id === task.id);
    expect(card?.deployedAt).toBeTruthy();
    expect(card?.deployment?.state).toBe("deployed");
    expect(board.deployBatch?.state).toBe("success");
    expect(board.deployBatch?.error ?? null).toBeNull();
    expect(restarts).toEqual(["task_batch_deploy"]);
  });

  test("takes in a card left resting in « Terminé », then archives it too", async () => {
    const queued = await seedQueued("Login", "task/login");
    const forgotten = await seedFinished("Graphe", "task/graphe");
    const deployer = buildDeployer({
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
    });

    const result = await deployer.deployAll("proj-1");
    // Both cards belong to the run: the build carries both either way.
    expect(result.taskIds.sort()).toEqual([forgotten.id, queued.id].sort());
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");

    const board = await service.getBoard("proj-1");
    const card = board.tasks.find((entry) => entry.id === forgotten.id);
    expect(card?.deployedAt).toBeTruthy();
    // Published cards are filed away, so the queue empties itself.
    expect(card?.column).toBe("archived");
    expect(board.deployBatch?.taskIds.sort()).toEqual([forgotten.id, queued.id].sort());
  });

  test("restarts the engine even when the work looks interface-only", async () => {
    // The restart is a step of the publication, not a reaction to what the batch
    // contains: "Redémarrage requis" is a heuristic over changed paths, and a
    // daemon change it fails to recognise would otherwise go online while the
    // engine keeps running the previous build.
    const card = await seedQueued("Interface", "task/interface");
    const deployer = buildDeployer({
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
    });

    await deployer.deployAll("proj-1");
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");

    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === card.id)?.deployedAt).toBeTruthy();
    expect(restarts).toEqual(["task_batch_deploy"]);
  });

  test("clears « Redémarrage requis » on the cards it publishes", async () => {
    const card = await seedQueued("Login", "task/login");
    await service.patchTask("proj-1", card.id, (current) => ({
      ...current,
      needsDaemonRestart: true,
    }));
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
    });

    await deployer.deployAll("proj-1");
    await settle(() => restarts.length > 0);
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.state === "success");

    // The batch restarts the daemon itself, so the flag that offered a manual
    // restart must be gone — no stale amber badge left on the archived card.
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === card.id)?.needsDaemonRestart).toBe(false);
  });

  test("a publication that never starts is reported, not swallowed", async () => {
    await seedQueued("Login", "task/login");
    const deployer = buildDeployer({ started: false });

    await deployer.deployAll("proj-1");
    await settle();

    expect(notes.at(-1)).toContain("déjà en cours");
    expect(restarts).toEqual([]);
  });

  test("refuses to publish while a card is still running", async () => {
    await seedQueued("Login", "task/login");
    const running = await service.createTask("proj-1", {
      folderId: (await service.getBoard("proj-1")).folders[0]?.id ?? "",
      title: "Encore en cours",
    });
    await service.moveTask("proj-1", {
      taskId: running.id,
      column: "in_progress",
      index: 0,
      manual: true,
    });

    await expect(buildDeployer({}).deployAll("proj-1")).rejects.toThrow(/en cours/);
    expect(triggered).toHaveLength(0);
  });

  test("refuses when everything in the column is already live", async () => {
    const task = await seedQueued("Login", "task/login");
    await service.markTaskDeployed("proj-1", task.id, { url: "https://app.haikostudio.cloud" });

    await expect(buildDeployer({}).deployAll("proj-1")).rejects.toThrow(/Aucune tâche à déployer/);
  });

  test("an ordinary project deploys card by card, through each card's own agent", async () => {
    const first = await seedQueued("Login", "task/login");
    const second = await seedQueued("Signup", "task/signup");
    const deployer = buildDeployer({ isSelfHost: false });

    await deployer.deployAll("proj-1");
    await settle();

    expect(triggered).toHaveLength(0);
    expect(perCard).toEqual([first.id, second.id]);
    // No single run to follow: each card carries its own publication state.
    expect((await service.getBoard("proj-1")).deployBatch ?? null).toBeNull();
    // No daemon restart on a client project: its own service is restarted by the
    // agent that deployed it.
    expect(restarts).toEqual([]);
  });

  test("a second request while one is running is queued, not run in parallel", async () => {
    await seedQueued("Login", "task/login");
    let release: (() => void) | null = null;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [{ deploying: false, phase: "done", outcome: "success", error: null }],
      holdTrigger: hold,
    });

    // First publication starts and is held mid-flight (triggerDeploy blocked).
    const first = await deployer.deployAll("proj-1");
    expect(first).toEqual({
      started: true,
      queued: false,
      taskIds: [expect.any(String)],
    });
    await settle(() => triggered.length === 1);

    // A second press lands while the first is still active: it is QUEUED, not
    // started in parallel and not refused. The board shows it as "en attente".
    const second = await deployer.deployAll("proj-1");
    expect(second).toEqual({ started: false, queued: true, taskIds: [] });
    expect(triggered).toHaveLength(1);
    expect((await service.getBoard("proj-1")).deployBatch?.queued).toBe(true);

    // The first finishes and puts everything online. The queued run then finds
    // nothing left to publish — it is dropped cleanly, never run empty, and the
    // "en attente" marker is cleared.
    release?.();
    await settle(async () => (await service.getBoard("proj-1")).deployBatch?.queued === false);
    expect(triggered).toHaveLength(1);
    const board = await service.getBoard("proj-1");
    expect(board.deployBatch?.state).toBe("success");
    expect(board.deployBatch?.queued).toBe(false);
  });

  test("a queued publication runs when work is still waiting", async () => {
    await seedQueued("Login", "task/login");
    let release: (() => void) | null = null;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deployer = buildDeployer({
      url: "https://app.haikostudio.cloud",
      runs: [
        { deploying: false, phase: "done", outcome: "success", error: null },
        { deploying: false, phase: "done", outcome: "success", error: null },
      ],
      holdTrigger: hold,
    });

    await deployer.deployAll("proj-1");
    await settle(() => triggered.length === 1);

    // A brand-new card arrives while the first run is held, then a second press
    // queues behind it.
    const late = await seedQueued("Signup", "task/signup");
    const queued = await deployer.deployAll("proj-1");
    expect(queued.queued).toBe(true);

    // Releasing the first lets it finish, then the queued run starts on its own
    // and publishes the card that was still waiting. Two runs, one after another.
    release?.();
    await settle(async () => {
      const board = await service.getBoard("proj-1");
      let lateIsLive = false;
      for (const task of board.tasks) {
        if (task.id === late.id) {
          lateIsLive = Boolean(task.deployedAt);
          break;
        }
      }
      return triggered.length === 2 && lateIsLive;
    });
    // Let the fire-and-forget cycle release its lock and finish its final write
    // before the temporary board store is removed by afterEach.
    await settle();
    expect(triggered).toHaveLength(2);
    const board = await service.getBoard("proj-1");
    expect(board.tasks.find((entry) => entry.id === late.id)?.deployedAt).toBeTruthy();
  });
});
