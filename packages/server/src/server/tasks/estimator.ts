import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { TaskBoardService } from "./service.js";
import type { TaskAgentProvisioner } from "./agent-provisioner.js";
import {
  buildTaskAnalysisPrompt,
  parseTaskAnalysisEstimate,
  resolveTaskLaunch,
  withBillingDefaults,
  withTaskAttachments,
  type TaskAnalysisEstimate,
} from "./agent-launch.js";

interface TaskEstimatorOptions {
  agentManager: Pick<AgentManager, "runAgent" | "hasInFlightRun">;
  agentProvisioner: TaskAgentProvisioner;
  taskBoardService: TaskBoardService;
  projectRegistry: ProjectRegistry;
  logger: pino.Logger;
  /**
   * How many task analyses may run at once. Bounded on purpose: each analysis of
   * a fresh folder cuts a worktree, and a saturated disk makes tasks fail
   * silently (see the VPS disk gotcha). Defaults to {@link DEFAULT_MAX_CONCURRENT}.
   */
  maxConcurrent?: number;
  /**
   * Back-off before re-queuing an analysis whose agent was momentarily busy.
   * Injectable so tests don't wait the real {@link BUSY_RETRY_DELAY_MS}.
   */
  busyRetryDelayMs?: number;
  /**
   * How long to wait between "is the analysis agent at rest yet?" polls before
   * promoting a card out of "Validé" into "Planifié". Injectable so tests don't
   * wait the real {@link REST_POLL_INTERVAL_MS}.
   */
  restPollIntervalMs?: number;
}

const DEFAULT_MAX_CONCURRENT = 4;

// Before promoting an analyzed card into "Planifié", wait for its shared agent to
// actually release its analysis turn. runAgent resolves when the turn's stream
// ends, but the agent's run can take a beat longer to fully settle; promoting in
// that window parks the card in "Planifié" while the agent is still winding down,
// so it shows "Analyse en cours…" in a column that promises the analysis is over.
// Poll a bounded number of times (~10s total) and promote anyway if it never
// settles, so a wedged agent can never strand a costed card in "Validé".
const MAX_REST_POLLS = 40;
const REST_POLL_INTERVAL_MS = 250;

// Automatic retries before a failed analysis stops and waits for the user. Low
// on purpose: an analysis that fails three times is a real problem (no disk, no
// quota, a broken checkout), not a hiccup, and looping on it burns quota.
const MAX_ANALYSIS_ATTEMPTS = 3;

// A card's analysis reuses its VISIBLE agent. If that agent is momentarily busy
// (its own previous turn, an execution run, a user chatting with it), the run is
// rejected with "already has an active run". That is NOT an analysis failure —
// it's timing — so it must never burn one of the three real attempts (doing so
// is exactly how a healthy card ended up wearing "Analyse impossible" with an
// empty Facturation tab). We back off and re-queue, bounded so a permanently
// stuck agent still surfaces eventually instead of looping forever.
const MAX_BUSY_RETRIES = 8;
const BUSY_RETRY_DELAY_MS = 8_000;

// The agent-manager rejects a concurrent turn with this phrase; we match on it
// to tell "agent momentarily busy" apart from a genuine analysis failure.
function isAgentBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already has an active run");
}

/**
 * Analysis phase of the task pipeline. When a task enters "Validé"/"Planifié",
 * this spawns the task's real, VISIBLE agent (the same one that will execute it)
 * in its own worktree, links it to the task immediately so it shows up in the
 * task chat, and runs a read-only analysis turn. The agent streams a readable
 * assessment into the conversation and ends with a structured estimate, which
 * lands on the task (advancing pending_estimate → awaiting_slot). The agent is
 * left alive: the scheduler reuses it for execution — same conversation, so the
 * analysis is the starting point and execution simply continues it.
 *
 * Analyses run in PARALLEL — one agent per task — up to {@link maxConcurrent},
 * so validating a batch no longer waits one-at-a-time. The single exception is
 * tasks of the same branch-folder: they share one worktree (the first task cuts
 * it, the rest reuse it), so they're serialized among themselves to avoid a
 * double-create race. Tasks in different folders (and folderless/legacy tasks,
 * each with their own branch) analyze concurrently.
 */
export class TaskEstimator {
  private readonly agentManager: Pick<AgentManager, "runAgent" | "hasInFlightRun">;
  private readonly agentProvisioner: TaskAgentProvisioner;
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: pino.Logger;
  private readonly maxConcurrent: number;
  private readonly busyRetryDelayMs: number;
  private readonly restPollIntervalMs: number;
  // Pending analyses, each tagged with its serialization group (a branch-folder
  // key when the task shares a folder's worktree, otherwise a task-unique key).
  private readonly queue: { projectId: string; taskId: string; groupKey: string }[] = [];
  // Dedup set (`projectId:taskId`) covering both queued and enqueue-in-flight
  // requests, so a repeated validation doesn't double-analyze a task.
  private readonly queued = new Set<string>();
  // Groups with an analysis currently running; a group holds at most one slot.
  private readonly activeGroups = new Set<string>();
  private activeCount = 0;
  // Per-task count of consecutive "agent busy" re-queues, so a transient reject
  // never eats a real analysis attempt (see MAX_BUSY_RETRIES). Cleared on any
  // outcome that isn't a busy-retry (success, or a genuine recorded failure).
  private readonly busyRetries = new Map<string, number>();

  constructor(options: TaskEstimatorOptions) {
    this.agentManager = options.agentManager;
    this.agentProvisioner = options.agentProvisioner;
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "task-estimator" });
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.busyRetryDelayMs = options.busyRetryDelayMs ?? BUSY_RETRY_DELAY_MS;
    this.restPollIntervalMs = options.restPollIntervalMs ?? REST_POLL_INTERVAL_MS;
  }

  requestEstimate(projectId: string, taskId: string): void {
    const key = `${projectId}:${taskId}`;
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    void this.enqueue(projectId, taskId);
  }

  private async enqueue(projectId: string, taskId: string): Promise<void> {
    // Resolving the group needs the board (folder lookup); do it before queuing
    // so the scheduling loop below stays synchronous and race-free.
    const groupKey = await this.resolveGroupKey(projectId, taskId);
    this.queue.push({ projectId, taskId, groupKey });
    this.pump();
  }

  /**
   * A branch-folder's tasks share one worktree, so they serialize under the
   * folder key. Everything else — folderless/legacy tasks, plan-mode, or a
   * lookup failure — gets a task-unique key so it analyzes fully in parallel.
   */
  private async resolveGroupKey(projectId: string, taskId: string): Promise<string> {
    try {
      const board = await this.taskBoardService.getBoard(projectId);
      const task = board.tasks.find((entry) => entry.id === taskId);
      const folder = task?.folderId
        ? board.folders.find((entry) => entry.id === task.folderId)
        : undefined;
      if (folder?.branch) {
        return `${projectId}:folder:${folder.id}`;
      }
    } catch (error) {
      this.logger.warn({ err: error, projectId, taskId }, "Failed to resolve analysis group");
    }
    return `${projectId}:task:${taskId}`;
  }

  /**
   * Fills free concurrency slots. Synchronous and re-entrant-safe: it claims the
   * first queued item whose group isn't already running, launches it, and stops
   * when it hits the concurrency cap or every remaining item is group-blocked.
   */
  private pump(): void {
    while (this.activeCount < this.maxConcurrent) {
      const index = this.queue.findIndex((item) => !this.activeGroups.has(item.groupKey));
      if (index === -1) {
        break;
      }
      const [item] = this.queue.splice(index, 1);
      if (!item) {
        break;
      }
      this.queued.delete(`${item.projectId}:${item.taskId}`);
      this.activeGroups.add(item.groupKey);
      this.activeCount += 1;
      void this.runOne(item);
    }
  }

  private async runOne(item: {
    projectId: string;
    taskId: string;
    groupKey: string;
  }): Promise<void> {
    try {
      await this.estimate(item.projectId, item.taskId);
    } catch (error) {
      this.logger.warn(
        { err: error, projectId: item.projectId, taskId: item.taskId },
        "Task analysis failed",
      );
    } finally {
      this.activeGroups.delete(item.groupKey);
      this.activeCount -= 1;
      this.pump();
    }
  }

  private async estimate(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }
    // Done is terminal, and a task already analyzed keeps its estimate + agent.
    if (task.completedAt != null || task.column === "done" || task.estimate) {
      return;
    }
    // A card whose automatic retries are spent waits for the user to ask again
    // (see recordFailure) instead of re-running on every sweep.
    if (task.analysis?.exhausted === true) {
      return;
    }
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      this.logger.warn({ projectId, taskId }, "Cannot analyze task: project not found");
      return;
    }

    let estimate: TaskAnalysisEstimate;
    try {
      estimate = await this.analyze(projectId, task);
    } catch (error) {
      // A momentarily-busy agent is timing, not a failure: re-queue after a
      // short back-off WITHOUT spending an attempt, up to a bound.
      if (isAgentBusyError(error) && this.scheduleBusyRetry(projectId, taskId)) {
        return;
      }
      await this.recordFailure(projectId, taskId, error);
      return;
    }
    this.busyRetries.delete(`${projectId}:${taskId}`);

    const patched = await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      const next = { ...current };
      // A previous failure is history now.
      delete next.analysis;
      return {
        ...next,
        estimate: {
          // Backfill the Facturation fields from the task so the tab is never
          // blank, even if the agent omitted some of them.
          ...withBillingDefaults(estimate, current),
          model: resolveTaskLaunch(current).provider,
          estimatedAt: new Date().toISOString(),
        },
        ...(current.schedule?.state === "pending_estimate"
          ? { schedule: { ...current.schedule, state: "awaiting_slot" as const } }
          : {}),
      };
    });

    // Third automatic board move (see docs/task-board-cycle.md): a card whose
    // analysis just succeeded promotes itself out of the "Validé" consent gate
    // into "Planifié" so the scheduler picks it up — the user no longer has to
    // drag an already-costed card forward by hand. Strictly guarded to the
    // consent gate: a card the user already moved elsewhere, or one that entered
    // the pipeline via a direct drop into "Planifié", is left exactly where it
    // is. The estimate (and its awaiting_slot schedule) is preserved because
    // validated→scheduled is a move BETWEEN pipeline columns, which never
    // re-arms or disarms the schedule.
    if (patched.column === "validated") {
      // Analysis belongs to "Validé". Hold the card there until its shared agent
      // has actually released the analysis turn, so it never lands in "Planifié"
      // still showing "Analyse en cours…". Promoting while the agent is in-flight
      // is the exact contradiction we're guarding: the scheduler would then pick
      // the card up, fail its launch with "agent busy", and re-queue it each tick
      // — parking the running-agent card in "Planifié" the whole time.
      await this.waitForAgentAtRest(patched.links.taskAgentId ?? patched.links.primaryAgentId);
      await this.taskBoardService.transitionTask(projectId, taskId, "scheduled");
    }
  }

  /**
   * Waits until the task's analysis agent is genuinely at rest (no in-flight
   * run), bounded by {@link MAX_REST_POLLS}. Used before promoting a card into
   * "Planifié": the promotion must not happen while the shared agent is still
   * winding down its analysis turn, or the card shows "Analyse en cours…" in a
   * column that means the analysis is done. Promotes anyway once the budget is
   * spent, so a wedged agent can never strand a costed card in "Validé".
   */
  private async waitForAgentAtRest(agentId: string | null | undefined): Promise<void> {
    if (!agentId) {
      return;
    }
    for (let attempt = 0; attempt < MAX_REST_POLLS; attempt += 1) {
      if (!this.agentManager.hasInFlightRun(agentId)) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.restPollIntervalMs);
        // Never keep the process alive just to poll for an agent at rest.
        timer.unref?.();
      });
    }
  }

  /**
   * A failed analysis writes a FAILURE, never a placeholder estimate.
   *
   * The old behaviour stamped {@link ANALYSIS_FALLBACK_ESTIMATE} on the card so
   * the pipeline could keep moving. It also made the card unrepairable: this
   * method returns early on any task that already has an estimate, so the very
   * act of papering over the crash locked the card out of ever being analyzed
   * again — with an invented cost and invented billing hours on it. The card now
   * says it failed, retries a bounded number of times on its own, and then waits
   * for the user.
   */
  /**
   * Re-queues an analysis whose agent was momentarily busy, after a short
   * back-off, without spending one of the {@link MAX_ANALYSIS_ATTEMPTS}. Returns
   * true when it re-queued; false once {@link MAX_BUSY_RETRIES} is spent, so the
   * caller records a real failure instead of looping forever on a stuck agent.
   */
  private scheduleBusyRetry(projectId: string, taskId: string): boolean {
    const key = `${projectId}:${taskId}`;
    const count = (this.busyRetries.get(key) ?? 0) + 1;
    if (count > MAX_BUSY_RETRIES) {
      this.busyRetries.delete(key);
      return false;
    }
    this.busyRetries.set(key, count);
    this.logger.debug({ projectId, taskId, attempt: count }, "Analysis agent busy, retrying later");
    const timer = setTimeout(() => this.requestEstimate(projectId, taskId), this.busyRetryDelayMs);
    // Never keep the process alive just for a pending re-analysis.
    timer.unref?.();
    return true;
  }

  private async recordFailure(projectId: string, taskId: string, error: unknown): Promise<void> {
    this.busyRetries.delete(`${projectId}:${taskId}`);
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn({ err: error, projectId, taskId }, "Task analysis failed");
    await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      // Reconciliation: a valid estimate ALWAYS wins over a recorded failure.
      // Two analyses of the same card race on its single visible agent — one is
      // rejected with "already has an active run" while the OTHER finishes and
      // lands a real estimate. If the winner already persisted its estimate,
      // stamping the loser's failure here would paint "Analyse impossible" over a
      // card whose Facturation tab is fully filled. It never should: an estimate
      // on the card means the analysis succeeded, so the failure is dropped and
      // the card keeps its result. (The mirror case — this failure lands first,
      // the estimate second — self-heals: the success path deletes `analysis`.)
      if (current.estimate) {
        this.logger.info(
          { projectId, taskId, reason },
          "Analysis failure ignored: a valid estimate is already on the card",
        );
        return current;
      }
      const attempts = (current.analysis?.attempts ?? 0) + 1;
      const exhausted = attempts >= MAX_ANALYSIS_ATTEMPTS;
      return {
        ...current,
        analysis: {
          state: "failed" as const,
          attempts,
          reason,
          failedAt: new Date().toISOString(),
          ...(exhausted ? { exhausted: true } : {}),
        },
      };
    });
  }

  /**
   * User-initiated "analyser à nouveau".
   *
   * Analysis belongs to "Validé", so a re-analysis SENDS THE CARD BACK THERE —
   * a card cannot be re-analyzed while sitting in "Planifié" or "En cours"
   * pretending the earlier verdict still holds. It also clears the previous
   * estimate and any recorded failure: without that, {@link estimate} returns
   * early (an existing estimate, or spent attempts) and the button would do
   * nothing at all.
   *
   * A finished card ("Terminé"/"Déployé") is terminal and is left alone: the
   * user drags it back to "À faire" to start it over.
   */
  async retry(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task || task.column === "done" || task.column === "deployed") {
      return;
    }
    // Clear BEFORE moving: the move itself decides how to arm the schedule from
    // whether an estimate is present, and a stale one would arm it as "ready to
    // launch" instead of "to be analyzed".
    await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      const next = { ...current };
      delete next.analysis;
      delete next.estimate;
      delete next.progress;
      delete next.planReadyAt;
      return {
        ...next,
        schedule: { state: "pending_estimate" as const, attempts: 0 },
      };
    });
    if (task.column !== "validated") {
      await this.taskBoardService.transitionTask(projectId, taskId, "validated");
    }
    this.requestEstimate(projectId, taskId);
  }

  /**
   * Ensures the task's visible agent exists (creating it + its worktree and
   * linking it on first analysis), then runs the read-only analysis turn and
   * returns the parsed estimate (or the fallback when none is parseable).
   */
  private async analyze(projectId: string, task: KanbanTask): Promise<TaskAnalysisEstimate> {
    const { planMode } = resolveTaskLaunch(task);
    // The card already owns an agent (attached at creation); this only creates
    // one for legacy cards born before that rule.
    const provisioned = await this.agentProvisioner.ensure(projectId, task.id);
    if (!provisioned) {
      throw new Error(`Cannot analyze task ${task.id}: no agent could be attached`);
    }
    const { agentId } = provisioned;
    const branch = provisioned.branch ?? task.links.branch ?? null;

    const prompt = withTaskAttachments(buildTaskAnalysisPrompt({ task, planMode, branch }), task);
    const run = await this.agentManager.runAgent(agentId, prompt);
    const text = resolveFinalText(run.timeline, run.finalText);
    const estimate = parseTaskAnalysisEstimate(text);
    if (!estimate) {
      // The agent ran but produced no readable estimate. Treat it as a failure
      // (retriable) rather than inventing one: a made-up cost drives the quota
      // gate, the scheduling window AND the Facturation tab, so a wrong number
      // is worse than no number.
      throw new Error("L'agent n'a pas produit d'estimation lisible.");
    }
    return estimate;
  }
}

function resolveFinalText(timeline: AgentTimelineItem[], finalText: string): string {
  if (finalText.trim()) {
    return finalText;
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.type === "assistant_message" && item.text.trim()) {
      return item.text;
    }
  }
  return "";
}
