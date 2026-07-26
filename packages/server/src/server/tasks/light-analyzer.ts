import { z } from "zod";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import {
  buildStructuredAgentResponsePrompt,
  getStructuredAgentResponse,
} from "../agent/agent-response-loop.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { TaskBoardService } from "./service.js";
import type { TaskAgentProvisioner } from "./agent-provisioner.js";

// Same concurrency bound as the deep estimator: cheap calls, but there's no
// reason to fan out unboundedly if a batch of prompts lands at once.
const DEFAULT_MAX_CONCURRENT = 4;

// The refiner only ever cleans up text — never a cost, never a schedule.
const RefinementResultSchema = z.object({
  // Short imperative headline for the card. Kept tight so it reads at a glance.
  title: z.string().min(1).max(120),
  // The prompt tidied into a clear, complete instruction the pipeline agent can
  // act on later. Never invents scope — just cleans up what the user pasted.
  description: z.string().min(1),
});

type RefinementResult = z.infer<typeof RefinementResultSchema>;

interface TaskLightAnalyzerOptions {
  agentManager: Pick<AgentManager, "runAgent">;
  agentProvisioner: TaskAgentProvisioner;
  taskBoardService: TaskBoardService;
  maxConcurrent?: number;
  logger: pino.Logger;
}

/**
 * Light analysis phase — the ONLY analysis that runs while a task sits in
 * "À faire" (backlog). When a user drops a raw prompt as a task, this spawns a
 * short-lived internal Haiku agent that turns the pasted text into a clean card:
 * a short title + a tidied, complete description the pipeline can work from
 * later. It writes ONLY title/description and flips {@link KanbanTask.refinement}
 * pending → done.
 *
 * It deliberately produces NO cost estimate, NO billing, NO schedule — that is
 * the deep analysis ({@link TaskEstimator}), which only fires once the user
 * validates the task ("Validé"). Keeping the two apart is the whole point: the
 * backlog stays free of the expensive, quota-hungry analysis.
 *
 * Entirely fire-and-forget: any failure just leaves the raw title in place
 * (still marked done, so it never loops) and is never surfaced to the user.
 */
export class TaskLightAnalyzer {
  private readonly agentManager: Pick<AgentManager, "runAgent">;
  private readonly agentProvisioner: TaskAgentProvisioner;
  private readonly taskBoardService: TaskBoardService;
  private readonly maxConcurrent: number;
  private readonly logger: pino.Logger;
  // Keyed by `${projectId}:${taskId}` so a restart re-arm can't double-queue a
  // refinement that's already in flight.
  private readonly inflight = new Set<string>();
  private readonly queue: { projectId: string; taskId: string }[] = [];
  private active = 0;

  constructor(options: TaskLightAnalyzerOptions) {
    this.agentManager = options.agentManager;
    this.agentProvisioner = options.agentProvisioner;
    this.taskBoardService = options.taskBoardService;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.logger = options.logger.child({ module: "task-light-analyzer" });
  }

  /** Fire-and-forget: enqueue a backlog task for light refinement. */
  refine(projectId: string, taskId: string): void {
    const key = `${projectId}:${taskId}`;
    if (this.inflight.has(key)) {
      return;
    }
    this.inflight.add(key);
    this.queue.push({ projectId, taskId });
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      this.active += 1;
      void this.process(next.projectId, next.taskId)
        .catch((error) => {
          this.logger.debug({ err: error, taskId: next.taskId }, "Light analysis failed");
        })
        .finally(() => {
          this.inflight.delete(`${next.projectId}:${next.taskId}`);
          this.active -= 1;
          this.pump();
        });
    }
  }

  private async process(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    // Only refine a backlog card still awaiting it, with something to clean up.
    if (!task || task.column !== "backlog" || task.refinement !== "pending") {
      return;
    }
    const raw = (task.description ?? "").trim();
    if (!raw) {
      await this.markDone(projectId, taskId);
      return;
    }
    // Run this in the CARD'S OWN agent, not a throwaway one. The tidy-up is the
    // first thing that ever happens to a task, so it belongs in the task's
    // conversation like everything after it — otherwise the journal starts in
    // the middle of the story.
    const provisioned = await this.agentProvisioner.ensure(projectId, taskId);
    if (!provisioned) {
      await this.markDone(projectId, taskId);
      return;
    }

    const result = await this.runRefineAgent({ agentId: provisioned.agentId, prompt: raw });
    if (!result) {
      // The refiner couldn't produce a clean version — keep the raw title/prompt
      // as-is but stop pending so the scheduler never re-arms it forever.
      await this.markDone(projectId, taskId);
      return;
    }

    await this.taskBoardService.patchTask(projectId, taskId, (current) => {
      // Guard against a race: if the user already moved the card out of backlog
      // (e.g. validated) while we analyzed, don't clobber the pipeline's work.
      if (current.column !== "backlog") {
        return current;
      }
      return {
        ...current,
        title: result.title.trim(),
        normalizedTitle: result.title.trim().toLowerCase(),
        description: result.description,
        refinement: "done",
      };
    });
  }

  private async markDone(projectId: string, taskId: string): Promise<void> {
    try {
      await this.taskBoardService.patchTask(projectId, taskId, (current) =>
        current.column === "backlog" ? { ...current, refinement: "done" } : current,
      );
    } catch (error) {
      this.logger.debug({ err: error, taskId }, "Failed to clear refinement flag");
    }
  }

  private async runRefineAgent(input: {
    agentId: string;
    prompt: string;
  }): Promise<RefinementResult | null> {
    const basePrompt = [
      "Tu es un assistant qui met au propre une tâche pour un tableau kanban de développement.",
      "On te donne le texte BRUT qu'un utilisateur vient de coller pour créer une tâche.",
      "Ta mission, LÉGÈRE : produire un titre court et une description propre. NE CHIFFRE RIEN : pas de coût, pas de durée, pas d'estimation — uniquement du texte mis au clair.",
      "Tu peux lire quelques fichiers du dépôt (lecture seule) UNIQUEMENT si c'est utile pour formuler un titre pertinent. Ne modifie aucun fichier.",
      "",
      "Texte brut de l'utilisateur :",
      '"""',
      input.prompt,
      '"""',
      "",
      "Réponds avec :",
      "- title : un titre court à l'impératif (5 à 8 mots max) qui résume la tâche.",
      "- description : le prompt reformulé au propre, clair et complet, prêt à être exécuté plus tard par un agent. Conserve TOUT le contexte utile du texte brut ; n'invente aucun périmètre supplémentaire ; n'ajoute ni coût ni durée.",
    ].join("\n");

    const agentId = input.agentId;
    try {
      const initialPrompt = buildStructuredAgentResponsePrompt({
        prompt: basePrompt,
        schema: RefinementResultSchema,
        schemaName: "RefinementResult",
      });
      let first = true;
      return await getStructuredAgentResponse({
        caller: async (nextPrompt) => {
          const prompt = first ? initialPrompt : nextPrompt;
          first = false;
          const run = await this.agentManager.runAgent(agentId, prompt);
          return resolveFinalText(run.timeline, run.finalText);
        },
        prompt: basePrompt,
        schema: RefinementResultSchema,
        maxRetries: 1,
        schemaName: "RefinementResult",
      });
    } catch (error) {
      this.logger.debug({ err: error, agentId }, "Refine turn failed");
      return null;
    }
    // The agent is NEVER archived here: it belongs to the card and carries its
    // whole history from this first exchange onward.
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
