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
/**
 * Breathing room between "everything is live" and the daemon restart, so the
 * board update and the closing note reach the clients before the socket drops.
 */
const RESTART_GRACE_MS = 5_000;

/** Human phase labels, in the order the build script writes them. */
const PHASE_LABELS: Record<string, string> = {
  prepare: "Préparation des changements…",
  verify: "Vérification du code…",
  daemon: "Construction du moteur…",
  site: "Construction du site…",
  publish: "Mise en ligne…",
  restart: "Redémarrage du moteur…",
};

export interface TaskBatchDeployResult {
  /** True when the batch publication really started. */
  started: boolean;
  /**
   * True when a publication was already running for this project and this request
   * was placed in the queue instead. It will begin on its own once the active one
   * finishes — unless nothing is left to publish by then, in which case it is
   * dropped cleanly rather than run empty.
   */
  queued: boolean;
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
  /**
   * The version that is now online, read once the run succeeded. Stamped on each
   * published card so "Déployé" can name the exact build it refers to, instead of
   * becoming unanswerable as soon as a second publication follows.
   */
  readPublishedSha?: () => Promise<string | null>;
  /** Hands a deploy-then-confirm prompt to one card's own agent. */
  deployTask: (projectId: string, taskId: string) => Promise<unknown>;
  /** Restarts the daemon — the last step of a successful self-host batch, when needed. */
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
 *
 * Publications are SERIALIZED per project: only one runs at a time. A request
 * arriving while one is already active is not refused and not run in parallel —
 * it is queued, and starts on its own once the active publication ends. Two
 * publications on the same checkout used to overwrite each other's logs and
 * produce "ghost" runs whose real outcome was undefined; the queue is what stops
 * that. At most one request waits per project (a second folds into the same slot:
 * a queued run republishes whatever is in the column at its turn, so there is
 * nothing to accumulate). When its turn comes and everything is already live, the
 * queued run is dropped cleanly with a note instead of running empty.
 */
export class TaskBatchDeployer {
  private readonly options: TaskBatchDeployerOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: pino.Logger;
  /** Projects with a publication running right now — the one active slot. */
  private readonly running = new Set<string>();
  /**
   * Projects with exactly one publication waiting behind the active one, keyed to
   * the options it was requested with. Held in memory only: if the daemon is
   * restarted mid-publication the whole map dies with the process, so the "lock"
   * can never survive as a stuck ghost — a fresh daemon starts clean.
   */
  private readonly queued = new Map<string, { auto?: boolean }>();

  constructor(options: TaskBatchDeployerOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger.child({ module: "task-batch-deployer" });
  }

  async deployAll(
    projectId: string,
    options: { auto?: boolean } = {},
  ): Promise<TaskBatchDeployResult> {
    if (this.running.has(projectId)) {
      // A publication is already active: queue exactly one behind it instead of
      // refusing (the old behaviour) or racing it. A second request while one
      // already waits simply refreshes the slot — the queued run republishes
      // whatever is in the column when its turn comes, so nothing accumulates.
      this.queued.set(projectId, options);
      await this.setWaitingMarker(projectId, true);
      this.logger.info({ projectId }, "Publication queued behind the active one");
      return { started: false, queued: true, taskIds: [] };
    }
    // Claim the single slot SYNCHRONOUSLY, before the first await, so two
    // near-simultaneous presses cannot both pass the guard above and start in
    // parallel. Releasing it is owned entirely by finishCycle (see beginCycle).
    this.running.add(projectId);
    return this.beginCycle(projectId, options, { fromQueue: false });
  }

  /**
   * Validate, open the windows and launch one publication. The `running` slot is
   * assumed already claimed by the caller. Every exit path hands the slot to
   * `finishCycle` — directly here when nothing starts (empty/busy), or via
   * `run(...).finally` when a run does start — so the lock is always released and
   * the queue always drains, even on failure.
   */
  private async beginCycle(
    projectId: string,
    options: { auto?: boolean },
    { fromQueue }: { fromQueue: boolean },
  ): Promise<TaskBatchDeployResult> {
    let board: Awaited<ReturnType<TaskBoardService["getBoard"]>>;
    try {
      board = await this.options.taskBoardService.getBoard(projectId);
    } catch (error) {
      await this.finishCycle(projectId);
      throw error;
    }
    const pending = selectPendingDeployTasks(board.tasks);
    const busy = board.tasks.filter((task) => task.column === "in_progress" && !task.archivedAt);
    if (pending.length === 0 || busy.length > 0) {
      // Nothing (left) to publish, or the workshop is busy. A QUEUED request that
      // lands here is stale — the publication that just finished already put
      // everything online, or fresh work is back in progress — so drop it cleanly
      // with a note rather than running empty. A DIRECT press still gets the
      // familiar refusal so the button can explain why it did nothing.
      if (fromQueue) {
        await this.dropStaleQueued(projectId, pending.length === 0);
        await this.finishCycle(projectId);
        return { started: false, queued: false, taskIds: [] };
      }
      await this.finishCycle(projectId);
      if (pending.length === 0) {
        throw new TaskBoardServiceError(
          "batch_deploy_empty",
          "Aucune tâche à déployer : tout ce qui attend dans cette colonne est déjà en ligne.",
        );
      }
      throw new TaskBoardServiceError(
        "batch_deploy_workshop_busy",
        `${busy.length} tâche(s) sont encore en cours : attendez qu'elles se terminent avant de publier, sinon la construction embarquerait du code inachevé.`,
      );
    }

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
    // ligne" recap. Titles are snapshotted so the recap survives a rename. A fresh
    // record starts with no "en attente" flag — this run IS the active one now.
    await this.options.taskBoardService.setDeployBatch(projectId, {
      state: "running",
      phase: null,
      startedAt,
      finishedAt: null,
      taskIds,
      titles: pending.map((task) => task.title),
      url: null,
      error: null,
      queued: false,
      ...(options.auto ? { auto: true } : {}),
    });
    void this.run(projectId, pending)
      .catch((error) => {
        this.logger.error({ err: error, projectId }, "Batch deployment failed");
      })
      .finally(() => {
        void this.finishCycle(projectId);
      });
    return { started: true, queued: false, taskIds };
  }

  /**
   * Release the active slot and hand it to whatever was waiting. Called exactly
   * once per publication (whether it started a run or aborted on validation). If a
   * request is queued, it claims the slot synchronously and begins — recomputing
   * what is left to publish, so a queued run that has become stale drops itself
   * rather than running empty.
   */
  private async finishCycle(projectId: string): Promise<void> {
    this.running.delete(projectId);
    const next = this.queued.get(projectId);
    if (!next) {
      return;
    }
    this.queued.delete(projectId);
    // Claim the slot before the first await inside beginCycle, same as deployAll,
    // so a press arriving right now queues rather than starting a third run.
    this.running.add(projectId);
    try {
      await this.beginCycle(projectId, next, { fromQueue: true });
    } catch (error) {
      // beginCycle already released the slot on its throw paths; just record it.
      this.logger.error({ err: error, projectId }, "Queued publication failed to start");
    }
  }

  /** Show/hide the board's "une publication en attente" marker. Never throws. */
  private async setWaitingMarker(projectId: string, waiting: boolean): Promise<void> {
    try {
      // patchDeployBatch no-ops when there is no active batch record, which is
      // exactly right: there is nothing to wait behind, so nothing to show.
      await this.options.taskBoardService.patchDeployBatch(projectId, { queued: waiting });
    } catch (error) {
      this.logger.debug({ err: error, projectId }, "Failed to update the queued marker");
    }
  }

  /**
   * A queued publication whose turn came with nothing left to do. Clear the
   * "en attente" marker so the board stops promising a run that will not happen;
   * the previous publication's recap (usually "c'est en ligne") stays in place as
   * the honest last word.
   */
  private async dropStaleQueued(projectId: string, alreadyLive: boolean): Promise<void> {
    await this.setWaitingMarker(projectId, false);
    this.logger.info(
      { projectId, alreadyLive },
      alreadyLive
        ? "Queued publication dropped: everything is already online"
        : "Queued publication dropped: the workshop is busy again",
    );
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
    let lastPhase: string | null = null;
    // Subscribe once and share the promise with succeed(). An idle agent is not
    // a failed agent: it may be waiting for the user, a permission or an external
    // operation. Only the deploy run's verified outcome is allowed to close the
    // progress window or produce an error.
    const idle =
      input.agentId && this.options.awaitDeployAgentIdle
        ? this.options.awaitDeployAgentIdle(input.agentId)
        : null;
    while (true) {
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
        continue;
      }
      // A temporarily unreadable/unknown run is not evidence of failure. Keep
      // the shared progress visible and poll again until the live check records
      // a definitive success or failure.
    }
  }

  /** Never lets an unreadable version marker break a successful publication. */
  private async readPublishedSha(): Promise<string | null> {
    try {
      return (await this.options.readPublishedSha?.()) ?? null;
    } catch (error) {
      this.logger.debug({ err: error }, "Published version could not be read");
      return null;
    }
  }

  /** Everything is online: stamp the cards, then restart the engine if needed. */
  private async succeed(
    projectId: string,
    pending: KanbanTask[],
    url: string | null,
    /** The agent's shared rest promise, awaited so the restart never cuts it off. */
    idle: Promise<void> | null,
  ): Promise<void> {
    // Read once for the whole batch: every card of a run goes live in the same
    // build, and a per-card read would only invite them to disagree.
    const publishedSha = await this.readPublishedSha();
    const needsDaemonRestart = pending.some((task) => task.needsDaemonRestart === true);
    for (const task of pending) {
      try {
        // Clear "Redémarrage requis" as we stamp: this batch restarts the daemon
        // itself as its last step, so the change is about to take effect — leaving
        // the flag on would strand a stale amber badge / "Redémarrer le moteur"
        // button on a card whose restart is already handled.
        await this.options.taskBoardService.markTaskDeployed(projectId, task.id, {
          url,
          needsDaemonRestart: false,
          sha: publishedSha,
        });
      } catch (error) {
        this.logger.warn({ err: error, projectId, taskId: task.id }, "Failed to stamp a live card");
      }
    }
    await this.sayAll(
      pending,
      url
        ? `✅ **Publication groupée** — c'est en ligne : ${url}`
        : "✅ **Publication groupée** — c'est en ligne.",
    );
    // Interface-only work is already operational once the published files are
    // served. Do not bounce the daemon just for ceremony.
    if (!needsDaemonRestart) {
      await this.finishSuccessfully(projectId, url);
      return;
    }
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
    // Daemon code changed, so the last step is restarting it. Nothing else ever
    // restarts it on its own.
    await this.sayAll(
      pending,
      "🔄 **Publication groupée** — redémarrage du moteur pour appliquer les changements…",
    );
    await this.options.taskBoardService.patchDeployBatch(projectId, { phase: "restart" });
    await this.sleep(RESTART_GRACE_MS);
    try {
      // The restart deliberately ends this daemon process. Record the terminal
      // outcome first, after every earlier phase and the live version check have
      // succeeded, so the verdict cannot be lost when the process hands over.
      await this.finishSuccessfully(projectId, url);
      this.options.requestDaemonRestart("task_batch_deploy");
    } catch (error) {
      this.logger.error({ err: error, projectId }, "Daemon restart request failed");
      // The site and cards are already live at this point. This is a final
      // restart problem, not a failed publication, so never rewrite that fact.
      await this.options.taskBoardService.patchDeployBatch(projectId, {
        state: "failed",
        finishedAt: new Date().toISOString(),
        error: "Le site est en ligne, mais le redémarrage final n'a pas pu être lancé.",
      });
      await this.sayAll(
        pending,
        "⚠️ **Publication groupée** — le site est en ligne, mais le redémarrage final n'a pas pu être lancé.",
      );
    }
  }

  private async finishSuccessfully(projectId: string, url: string | null): Promise<void> {
    await this.options.taskBoardService.patchDeployBatch(projectId, {
      state: "success",
      phase: "done",
      finishedAt: new Date().toISOString(),
      url,
      error: null,
    });
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
