import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { TaskBoardService } from "./service.js";
import { resolveTaskAgentId } from "./validator.js";

/** How often the publication is checked while it runs. */
const POLL_INTERVAL_MS = 5_000;
/** Hard stop for the watcher, slightly above the deploy's own 30 min ceiling. */
const MAX_WATCH_MS = 35 * 60 * 1000;

/** Human phase labels, in the order the build script writes them. */
const PHASE_LABELS: Record<string, string> = {
  save: "Sauvegarde du travail…",
  build: "Construction de l'application…",
  publish: "Mise en ligne…",
};

export interface DeployTriggerResult {
  started: boolean;
  error?: string | null;
}

export interface DeployRunSnapshot {
  deploying: boolean;
  phase: string | null;
  outcome: "success" | "failed" | null;
  error: string | null;
}

export interface TaskPublisherOptions {
  taskBoardService: TaskBoardService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  agentManager: Pick<AgentManager, "appendTimelineItem">;
  /** True when this project's checkout is the Paseo repo (daemon-published). */
  isSelfHostRoot: (rootPath: string | null | undefined) => boolean;
  /** Public address serving this project, or null when it has no instance. */
  resolveProjectUrl: (rootPath: string | null) => Promise<string | null>;
  triggerDeploy: (input: {
    projectId: string;
    mergeBranches: string[];
  }) => Promise<DeployTriggerResult>;
  readDeployRun: () => Promise<DeployRunSnapshot>;
  /** Injected so tests don't wait on real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger: pino.Logger;
}

/**
 * Publication is no longer a button: finishing a card is what puts its work
 * online, so this runs the moment a card lands in "Terminée".
 *
 * Two shapes, one rule — the user sees it happen where the work happened:
 * - **Paseo itself** is published by the daemon (local build → Caddy webroot),
 *   and the progress is narrated straight into the card's own conversation,
 *   because the sheet that used to show a progress bar no longer exists.
 * - **Any other project** is deployed by the card's agent during the final
 *   check; here we only stamp the address it went live at.
 *
 * The card ends up carrying {@link KanbanTask.deployedUrl}, so a finished card
 * is one tap away from the thing it changed.
 */
export class TaskPublisher {
  private readonly options: TaskPublisherOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: pino.Logger;

  constructor(options: TaskPublisherOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger.child({ module: "task-publisher" });
  }

  async handleCompleted(projectId: string, task: KanbanTask): Promise<void> {
    const project = await this.options.projectRegistry.get(projectId);
    const rootPath = project?.rootPath ?? null;
    const url = await this.options.resolveProjectUrl(rootPath);

    if (!this.options.isSelfHostRoot(rootPath)) {
      // The agent deployed this one itself during the check; just record where.
      if (url) {
        await this.stampUrl(projectId, task.id, url);
      }
      return;
    }

    const agentId = resolveTaskAgentId(task);
    const branch = task.links.branch ?? null;
    await this.say(agentId, "🚀 **Publication** — mise en ligne de cette tâche en cours…");

    const result = await this.options.triggerDeploy({
      projectId,
      mergeBranches: branch ? [branch] : [],
    });
    if (!result.started) {
      await this.say(
        agentId,
        `⚠️ **Publication** — elle n'a pas pu démarrer : ${result.error ?? "raison inconnue"}`,
      );
      return;
    }
    await this.watch({ projectId, taskId: task.id, agentId, url });
  }

  /** Follows the running publication, narrating each phase change once. */
  private async watch(input: {
    projectId: string;
    taskId: string;
    agentId: string | null;
    url: string | null;
  }): Promise<void> {
    const deadline = this.now() + MAX_WATCH_MS;
    let lastPhase: string | null = null;
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
        const label = PHASE_LABELS[run.phase];
        if (label) {
          await this.say(input.agentId, `⏳ **Publication** — ${label}`);
        }
      }
      if (run.deploying) {
        continue;
      }
      if (run.outcome === "success") {
        if (input.url) {
          await this.stampUrl(input.projectId, input.taskId, input.url);
        }
        await this.say(
          input.agentId,
          input.url
            ? `✅ **Publication** — c'est en ligne : ${input.url}`
            : "✅ **Publication** — c'est en ligne.",
        );
        return;
      }
      if (run.outcome === "failed") {
        await this.say(
          input.agentId,
          `❌ **Publication** — échec : ${run.error ?? "raison inconnue"}`,
        );
        return;
      }
      // No run known any more (retention expired): stop quietly rather than
      // narrating a state we can't vouch for.
      return;
    }
    await this.say(
      input.agentId,
      "⚠️ **Publication** — toujours en cours après 35 minutes, je cesse de la suivre.",
    );
  }

  private async stampUrl(projectId: string, taskId: string, url: string): Promise<void> {
    try {
      await this.options.taskBoardService.patchTask(projectId, taskId, (current) => ({
        ...current,
        deployedUrl: url,
      }));
    } catch (error) {
      this.logger.warn({ err: error, projectId, taskId }, "Failed to stamp the deployed URL");
    }
  }

  /** Posts a note into the card's conversation; never throws. */
  private async say(agentId: string | null, text: string): Promise<void> {
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
