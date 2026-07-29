import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { TaskBoardServiceError, type TaskBoardService } from "./service.js";
import { resolveTaskAgentId } from "./validator.js";

export interface DeployTriggerResult {
  started: boolean;
  error?: string | null;
  /** The grouped deploy agent launched for this run, when there is one. */
  agentId?: string | null;
}

export interface DeployRunSnapshot {
  deploying: boolean;
  phase: string | null;
  outcome: "success" | "failed" | null;
  error: string | null;
}

/** How often the publication is polled while it runs. */
const POLL_INTERVAL_MS = 5_000;
/** Hard stop for the watcher, slightly above the deploy's own 30 min ceiling. */
const MAX_WATCH_MS = 35 * 60 * 1000;
/**
 * How many consecutive polls the grouped deploy agent may sit at rest while the
 * run still reports "deploying" before we call it a stall. One poll of grace
 * absorbs the tiny window between the agent finishing and the run recording its
 * outcome; beyond that, an agent at rest with no verdict has stopped for good —
 * almost always because it paused to ask a question — and will never finish on
 * its own. Concluding here is what stops the batch from hanging the full 35 min.
 */
const IDLE_STALL_POLLS = 2;
/**
 * Breathing room between "everything is live" and the daemon restart, so the
 * board update and the closing note reach the clients before the socket drops.
 */
const RESTART_GRACE_MS = 5_000;

/** Human phase labels, in the order the build script writes them. */
const PHASE_LABELS: Record<string, string> = {
  save: "Sauvegarde du travail…",
  build: "Construction de l'application…",
  publish: "Mise en ligne…",
};

export interface TaskBatchDeployResult {
  /** True when the batch publication really started. */
  started: boolean;
  /** The cards this run is taking online. */
  taskIds: string[];
}

export interface TaskBatchDeployerOptions {
  taskBoardService: TaskBoardService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  agentManager: Pick<AgentManager, "appendTimelineItem">;
  /** True when this project's checkout is the Paseo repo (daemon-published). */
  isSelfHostRoot: (rootPath: string | null | undefined) => boolean;
  /** Public address serving this project, or null when it has no instance. */
  resolveProjectUrl: (rootPath: string | null) => Promise<string | null>;
  /** Starts the publication (merges the cards' branches, builds, puts online). */
  triggerDeploy: (input: {
    projectId: string;
    mergeBranches: string[];
  }) => Promise<DeployTriggerResult>;
  readDeployRun: () => Promise<DeployRunSnapshot>;
  /** Hands a deploy-then-confirm prompt to one card's own agent. */
  deployTask: (projectId: string, taskId: string) => Promise<unknown>;
  /** Restarts the daemon — the last step of a successful self-host batch. */
  requestDaemonRestart: (reason: string) => void;
  /**
   * Resolves once the grouped deploy agent has gone back to rest (posted its own
   * final verdict), or after a guard timeout. Awaited before the daemon restart
   * so the restart never cuts the agent off mid-sentence — the frozen "le suivi
   * est en place, j'attends la fin…" message the user used to be left with.
   * Absent on the per-card path (no grouped agent to wait for).
   */
  awaitDeployAgentIdle?: (agentId: string) => Promise<void>;
  /** Injected so tests don't wait on real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger: pino.Logger;
}

/** True once a card's work is actually live (mirrors the app's isTaskDeployed). */
export function isTaskLive(task: KanbanTask): boolean {
  return (
    task.deployedAt != null || task.deployment?.state === "deployed" || Boolean(task.deployedUrl)
  );
}

/**
 * The cards a "Tout déployer" press would take online, in board order: queued,
 * not archived, not live, and not held back by "Retirer du prochain lot".
 */
export function selectPendingDeployTasks(tasks: readonly KanbanTask[]): KanbanTask[] {
  return tasks.filter(
    (task) =>
      task.column === "deployed" &&
      !task.archivedAt &&
      task.deployHold !== true &&
      !isTaskLive(task),
  );
}

/**
 * "Tout déployer" — the button at the bottom of the "À déployer" column.
 *
 * Finishing a card no longer publishes it: it parks the card in the last column,
 * which is a QUEUE. This publishes everything waiting there in ONE run, and
 * restarts the daemon at the end so the freshly published code is the code that
 * runs. One run for the whole batch is the point — the old per-card publication
 * raced itself on the shared checkout and produced torn builds.
 *
 * Two shapes, one gesture:
 * - **Paseo itself** is published by the daemon (`triggerDeploy` builds the
 *   project's main branch and hands it to its own supervising agent). Tasks work
 *   in place on main, so there is nothing to merge — the deploy just builds what
 *   is already there. We watch the run, narrate each phase into every card's
 *   conversation, stamp the cards live, then restart the daemon.
 * - **Any other project** is deployed card by card by each card's OWN agent (the
 *   existing "Lancer le déploiement" path), because the agent is the only one who
 *   knows that project's dev instance. No daemon restart there: the project's own
 *   service is restarted by the agent.
 *
 * It refuses to start while cards are still running ("En cours"): a build taken
 * from a checkout other agents are writing into is the torn-bundle bug.
 */
export class TaskBatchDeployer {
  private readonly options: TaskBatchDeployerOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: pino.Logger;
  private readonly running = new Set<string>();

  constructor(options: TaskBatchDeployerOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger.child({ module: "task-batch-deployer" });
  }

  async deployAll(
    projectId: string,
    options: { auto?: boolean } = {},
  ): Promise<TaskBatchDeployResult> {
    if (this.running.has(projectId)) {
      throw new TaskBoardServiceError(
        "batch_deploy_running",
        "Une publication groupée est déjà en cours pour ce projet.",
      );
    }
    const board = await this.options.taskBoardService.getBoard(projectId);
    const pending = selectPendingDeployTasks(board.tasks);
    if (pending.length === 0) {
      throw new TaskBoardServiceError(
        "batch_deploy_empty",
        "Aucune tâche à déployer : tout ce qui attend dans cette colonne est déjà en ligne.",
      );
    }
    const busy = board.tasks.filter((task) => task.column === "in_progress" && !task.archivedAt);
    if (busy.length > 0) {
      throw new TaskBoardServiceError(
        "batch_deploy_workshop_busy",
        `${busy.length} tâche(s) sont encore en cours : attendez qu'elles se terminent avant de publier, sinon la construction embarquerait du code inachevé.`,
      );
    }

    this.running.add(projectId);
    const startedAt = new Date().toISOString();
    // Open the deploy window on every card of the batch BEFORE anything starts:
    // that is what the board shows as "Publication en cours", and — on an ordinary
    // project — what authorizes each card's agent to confirm its own deployment.
    for (const task of pending) {
      await this.options.taskBoardService.patchTask(projectId, task.id, (current) => ({
        ...current,
        deployment: { state: "running" as const, startedAt },
      }));
    }
    const taskIds = pending.map((task) => task.id);
    // The board carries the run itself: the column turns it into one progress
    // bar for the whole batch, then into the "voici ce qui vient d'être mis en
    // ligne" recap. Titles are snapshotted so the recap survives a rename.
    await this.options.taskBoardService.setDeployBatch(projectId, {
      state: "running",
      phase: null,
      startedAt,
      finishedAt: null,
      taskIds,
      titles: pending.map((task) => task.title),
      url: null,
      error: null,
      ...(options.auto ? { auto: true } : {}),
    });
    void this.run(projectId, pending)
      .catch((error) => {
        this.logger.error({ err: error, projectId }, "Batch deployment failed");
      })
      .finally(() => {
        this.running.delete(projectId);
      });
    return { started: true, taskIds };
  }

  private async run(projectId: string, pending: KanbanTask[]): Promise<void> {
    const project = await this.options.projectRegistry.get(projectId);
    const rootPath = project?.rootPath ?? null;
    await this.sayAll(pending, `🚀 **Publication groupée** — ${pending.length} tâche(s) en file.`);

    if (!this.options.isSelfHostRoot(rootPath)) {
      await this.runPerCard(projectId, pending);
      return;
    }

    // Tasks run in place on main — there are no per-task branches to merge. The
    // deploy just builds the project's main branch as it already stands.
    const result = await this.options.triggerDeploy({ projectId, mergeBranches: [] });
    if (!result.started) {
      await this.fail(projectId, pending, result.error ?? "raison inconnue");
      return;
    }
    // Point the board's progress banner at the single grouped deploy agent, so a
    // tap on the bar opens its conversation and the build/publish can be watched
    // live. Only when the launcher gave us one (self-host, real build).
    if (result.agentId) {
      await this.options.taskBoardService.patchDeployBatch(projectId, {
        agentId: result.agentId,
      });
    }
    const url = await this.options.resolveProjectUrl(rootPath);
    await this.watch({ projectId, pending, url, agentId: result.agentId ?? null });
  }

  /**
   * An ordinary project: each card's own agent deploys its own work, one after
   * the other. Sequential on purpose — two agents deploying the same project at
   * once would restart its service under each other's feet.
   */
  private async runPerCard(projectId: string, pending: KanbanTask[]): Promise<void> {
    for (const task of pending) {
      try {
        await this.options.deployTask(projectId, task.id);
      } catch (error) {
        this.logger.warn(
          { err: error, projectId, taskId: task.id },
          "Per-card deploy dispatch failed",
        );
        await this.say(
          task,
          `⚠️ **Publication groupée** — cette carte n'a pas pu être déployée : ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.closeWindow(projectId, task.id);
      }
    }
    // Every card is now in the hands of its own agent, each publishing at its
    // own pace: there is no single run left to show a progress bar for. The
    // board-level record steps aside and each card carries its own "Publication
    // en cours" badge until its agent confirms it live.
    await this.options.taskBoardService.setDeployBatch(projectId, null);
  }

  /** Follows the running publication, narrating each phase change once. */
  private async watch(input: {
    projectId: string;
    pending: KanbanTask[];
    url: string | null;
    /** The grouped deploy agent to let finish before the restart, if any. */
    agentId: string | null;
  }): Promise<void> {
    const deadline = this.now() + MAX_WATCH_MS;
    let lastPhase: string | null = null;
    // A grouped deploy agent that returns to rest WITHOUT the run reaching a live
    // outcome has stopped mid-publication — the classic cause is a question it
    // asked and is now waiting on. We watch for that in parallel so the batch can
    // fail fast with a clear reason instead of freezing the cards for 35 minutes.
    // Subscribe to the agent's rest ONCE and share it: the stall check below reads
    // it, and succeed() awaits the same promise before the restart. Calling
    // awaitDeployAgentIdle twice would double-subscribe and confuse the ordering.
    let agentAtRest = false;
    const idle =
      input.agentId && this.options.awaitDeployAgentIdle
        ? this.options.awaitDeployAgentIdle(input.agentId)
        : null;
    if (idle) {
      void (async () => {
        try {
          await idle;
          agentAtRest = true;
        } catch {
          // Idle wait failed — the stall check simply never fires; the 35 min
          // ceiling and the run's own outcome still close the batch.
        }
      })();
    }
    let stalledPolls = 0;
    while (this.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      let run: DeployRunSnapshot;
      try {
        run = await this.options.readDeployRun();
      } catch (error) {
        this.logger.debug({ err: error }, "Publication status read failed");
        continue;
      }
      if (run.phase && run.phase !== lastPhase) {
        lastPhase = run.phase;
        await this.options.taskBoardService.patchDeployBatch(input.projectId, {
          phase: run.phase,
        });
        const label = PHASE_LABELS[run.phase];
        if (label) {
          await this.sayAll(input.pending, `⏳ **Publication groupée** — ${label}`);
        }
      }
      // Outcome first: a run that concluded (success or failed) is authoritative
      // even if the agent has just gone to rest, so the stall check never fires
      // on a publication that actually finished.
      if (run.outcome === "success") {
        await this.succeed(input.projectId, input.pending, input.url, idle);
        return;
      }
      if (run.outcome === "failed") {
        await this.fail(input.projectId, input.pending, run.error ?? "raison inconnue");
        return;
      }
      if (run.deploying) {
        // The agent is idle but the run never concluded: after a poll of grace
        // (in case the outcome is a beat behind), call it a stall and fail with a
        // reason the user can act on, rather than hanging until the ceiling.
        if (agentAtRest && ++stalledPolls >= IDLE_STALL_POLLS) {
          await this.fail(
            input.projectId,
            input.pending,
            "L'agent de publication s'est arrêté avant d'avoir mis la nouvelle version en ligne (il attend peut-être une réponse de votre part). Rien n'a été publié.",
          );
          return;
        }
        continue;
      }
      // No run known any more (retention expired): stop quietly rather than
      // claiming an outcome we can't vouch for. The windows still close.
      await this.closeAll(input.projectId, input.pending);
      return;
    }
    await this.sayAll(
      input.pending,
      "⚠️ **Publication groupée** — toujours en cours après 35 minutes, je cesse de la suivre.",
    );
    await this.closeAll(input.projectId, input.pending);
  }

  /** Everything is online: stamp the cards, then restart the engine. */
  private async succeed(
    projectId: string,
    pending: KanbanTask[],
    url: string | null,
    /** The agent's shared rest promise, awaited so the restart never cuts it off. */
    idle: Promise<void> | null,
  ): Promise<void> {
    for (const task of pending) {
      try {
        // Clear "Redémarrage requis" as we stamp: this batch restarts the daemon
        // itself as its last step, so the change is about to take effect — leaving
        // the flag on would strand a stale amber badge / "Redémarrer le moteur"
        // button on a card whose restart is already handled.
        await this.options.taskBoardService.markTaskDeployed(projectId, task.id, {
          url,
          needsDaemonRestart: false,
        });
      } catch (error) {
        this.logger.warn({ err: error, projectId, taskId: task.id }, "Failed to stamp a live card");
      }
    }
    await this.options.taskBoardService.patchDeployBatch(projectId, {
      state: "success",
      phase: "done",
      finishedAt: new Date().toISOString(),
      url,
      error: null,
    });
    await this.sayAll(
      pending,
      url
        ? `✅ **Publication groupée** — c'est en ligne : ${url}`
        : "✅ **Publication groupée** — c'est en ligne.",
    );
    // The publication is live, but the grouped deploy agent may still be checking
    // the served version and writing its own closing verdict. Restarting now would
    // kill it mid-sentence and leave its chat frozen on "j'attends la fin…". So
    // wait for it to reach rest first — the restart is genuinely the LAST step,
    // after every card is stamped AND the agent has had its final say.
    if (idle) {
      try {
        await idle;
      } catch (error) {
        this.logger.debug({ err: error }, "Wait for deploy agent to finish failed");
      }
    }
    // The daemon is still running the code from BEFORE this publication, so the
    // last step of the batch is restarting it. That is exactly what the user
    // authorized by pressing the button — nothing else ever restarts it on its own.
    await this.sayAll(
      pending,
      "🔄 **Publication groupée** — redémarrage du moteur pour appliquer les changements…",
    );
    await this.sleep(RESTART_GRACE_MS);
    try {
      this.options.requestDaemonRestart("task_batch_deploy");
    } catch (error) {
      this.logger.error({ err: error, projectId }, "Daemon restart request failed");
    }
  }

  private async fail(projectId: string, pending: KanbanTask[], reason: string): Promise<void> {
    await this.options.taskBoardService.patchDeployBatch(projectId, {
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: reason,
    });
    // Say plainly what broke AND that nothing shipped: no card was marked live or
    // archived, so the queue is intact and the user can fix the cause and retry.
    await this.sayAll(
      pending,
      `❌ **Publication groupée** — échec : ${reason}\n\nRien n'a été mis en ligne et aucune carte n'a été archivée. Corrigez la cause ci-dessus, puis relancez « Tout déployer ».`,
    );
    for (const task of pending) {
      await this.markFailed(projectId, task.id);
    }
  }

  private async closeAll(projectId: string, pending: KanbanTask[]): Promise<void> {
    const reason =
      "Publication interrompue avant la fin : impossible de confirmer que la mise en ligne a abouti.";
    await this.options.taskBoardService.patchDeployBatch(projectId, {
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: reason,
    });
    // We could not vouch for a live result, so nothing is stamped or archived: the
    // cards stay in « À déployer », ready for a fresh « Tout déployer ».
    await this.sayAll(
      pending,
      `⚠️ **Publication groupée** — ${reason}\n\nAucune carte n'a été archivée ; la file reste en place. Vérifiez l'état du site, puis relancez la publication si besoin.`,
    );
    for (const task of pending) {
      await this.closeWindow(projectId, task.id);
    }
  }

  /** Reopens the button for this card: the window closes without a verdict. */
  private async closeWindow(projectId: string, taskId: string): Promise<void> {
    try {
      await this.options.taskBoardService.patchTask(projectId, taskId, (current) =>
        current.deployment?.state === "running" ? { ...current, deployment: null } : current,
      );
    } catch (error) {
      this.logger.debug({ err: error, projectId, taskId }, "Failed to close a deploy window");
    }
  }

  private async markFailed(projectId: string, taskId: string): Promise<void> {
    try {
      await this.options.taskBoardService.patchTask(projectId, taskId, (current) =>
        current.deployment?.state === "running"
          ? {
              ...current,
              deployment: { state: "failed" as const, startedAt: current.deployment?.startedAt },
            }
          : current,
      );
    } catch (error) {
      this.logger.debug({ err: error, projectId, taskId }, "Failed to mark a deploy as failed");
    }
  }

  private async sayAll(tasks: KanbanTask[], text: string): Promise<void> {
    for (const task of tasks) {
      await this.say(task, text);
    }
  }

  /** Posts a note into a card's conversation; never throws. */
  private async say(task: KanbanTask, text: string): Promise<void> {
    const agentId = resolveTaskAgentId(task);
    if (!agentId) {
      return;
    }
    try {
      await this.options.agentManager.appendTimelineItem(agentId, {
        type: "assistant_message",
        text,
      });
    } catch (error) {
      this.logger.debug({ err: error, agentId }, "Publication note not delivered");
    }
  }
}
