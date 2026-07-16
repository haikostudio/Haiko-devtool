import { z } from "zod";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import {
  buildStructuredAgentResponsePrompt,
  getStructuredAgentResponse,
} from "../agent/agent-response-loop.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import type { TaskBoardService } from "./service.js";

const ESTIMATOR_PROVIDER_MODEL = "claude/haiku";

const TaskEstimateResultSchema = z.object({
  tokens: z.number().int().nonnegative(),
  quotaPercent: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
});

// Applied when the estimator agent fails or returns unparseable output, so a
// scheduled task never sits in pending_estimate forever.
const FALLBACK_ESTIMATE = {
  tokens: 200_000,
  quotaPercent: 10,
  confidence: "low" as const,
  summary: "Estimation automatique indisponible — valeur par défaut prudente.",
};

interface TaskEstimatorOptions {
  agentManager: Pick<AgentManager, "runAgent" | "archiveAgent">;
  createAgent: BoundCreateAgentCommand;
  taskBoardService: TaskBoardService;
  projectRegistry: ProjectRegistry;
  logger: pino.Logger;
}

/**
 * Produces quota-cost estimates for tasks by running a short-lived internal
 * Haiku agent against the project checkout. Requests are processed one at a
 * time; results land on the task via TaskBoardService (which pushes to
 * subscribers), then the schedule state advances pending_estimate → awaiting_slot.
 */
export class TaskEstimator {
  private readonly agentManager: Pick<AgentManager, "runAgent" | "archiveAgent">;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: pino.Logger;
  private readonly queue: { projectId: string; taskId: string }[] = [];
  private readonly queued = new Set<string>();
  private processing = false;

  constructor(options: TaskEstimatorOptions) {
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "task-estimator" });
  }

  requestEstimate(projectId: string, taskId: string): void {
    const key = `${projectId}:${taskId}`;
    if (this.queued.has(key)) {
      return;
    }
    this.queued.add(key);
    this.queue.push({ projectId, taskId });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) {
          break;
        }
        this.queued.delete(`${next.projectId}:${next.taskId}`);
        try {
          await this.estimate(next.projectId, next.taskId);
        } catch (error) {
          this.logger.warn(
            { err: error, projectId: next.projectId, taskId: next.taskId },
            "Task estimate failed",
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async estimate(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      this.logger.warn({ projectId, taskId }, "Cannot estimate task: project not found");
      return;
    }

    const estimate = await this.runEstimatorAgent({
      cwd: project.rootPath,
      title: task.title,
      description: task.description ?? "",
      tags: task.tags,
    });

    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      estimate: {
        ...estimate,
        model: ESTIMATOR_PROVIDER_MODEL,
        estimatedAt: new Date().toISOString(),
      },
      ...(current.schedule?.state === "pending_estimate"
        ? { schedule: { ...current.schedule, state: "awaiting_slot" as const } }
        : {}),
    }));
  }

  private async runEstimatorAgent(input: {
    cwd: string;
    title: string;
    description: string;
    tags: string[];
  }): Promise<z.infer<typeof TaskEstimateResultSchema>> {
    const basePrompt = [
      "Tu es un estimateur de coût pour une tâche de développement qui sera exécutée par un agent de code (Claude).",
      "Explore UNIQUEMENT ce qui est nécessaire dans ce dépôt (lecture seule, quelques fichiers au plus) pour jauger l'ampleur de la tâche.",
      "",
      `Tâche : ${input.title}`,
      input.description ? `Description : ${input.description}` : "",
      input.tags.length > 0 ? `Tags : ${input.tags.join(", ")}` : "",
      "",
      "Estime :",
      "- tokens : total de tokens (entrée+sortie) que l'agent d'exécution consommera probablement",
      "- quotaPercent : part (0-100) d'une fenêtre de 5h d'un abonnement Claude que cela représente",
      "- confidence : low | medium | high",
      "- summary : justification en une phrase",
    ]
      .filter((line) => line !== "")
      .join("\n");

    let agentId: string | null = null;
    try {
      const created = await this.createAgent({
        kind: "mcp",
        provider: ESTIMATOR_PROVIDER_MODEL,
        cwd: input.cwd,
        title: `Estimation : ${input.title}`,
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
        internal: true,
      });
      agentId = created.snapshot.id;
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const initialPrompt = buildStructuredAgentResponsePrompt({
        prompt: basePrompt,
        schema: TaskEstimateResultSchema,
        schemaName: "TaskEstimateResult",
      });
      let first = true;
      const result = await getStructuredAgentResponse({
        caller: async (nextPrompt) => {
          const prompt = first ? initialPrompt : nextPrompt;
          first = false;
          if (!agentId) {
            throw new Error("Estimator agent missing");
          }
          const run = await this.agentManager.runAgent(agentId, prompt);
          return resolveFinalText(run.timeline, run.finalText);
        },
        prompt: basePrompt,
        schema: TaskEstimateResultSchema,
        maxRetries: 1,
        schemaName: "TaskEstimateResult",
      });
      return result;
    } catch (error) {
      this.logger.warn(
        { err: error, title: input.title },
        "Estimator agent failed, using fallback",
      );
      return FALLBACK_ESTIMATE;
    } finally {
      if (agentId) {
        try {
          await this.agentManager.archiveAgent(agentId);
        } catch {
          // Ignore cleanup errors for internal estimator agents.
        }
      }
    }
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
