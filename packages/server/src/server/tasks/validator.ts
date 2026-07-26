import { z } from "zod";
import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import {
  buildStructuredAgentResponsePrompt,
  getStructuredAgentResponse,
} from "../agent/agent-response-loop.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { TaskBoardServiceError, type TaskBoardService } from "./service.js";

// The check reads code and runs the project's own tests, so it needs a capable
// model — a cheap one would rubber-stamp the work, which defeats the purpose.
const DEFAULT_VALIDATION_PROVIDER_MODEL = "claude/sonnet";

const ValidationVerdictSchema = z.object({
  // true ONLY when the original request is genuinely satisfied and nothing is
  // broken. Anything doubtful is a failure — a wrong "passed" ships bad work.
  passed: z.boolean(),
  // One line, shown as a toast and next to the validate bar.
  summary: z.string().min(1).max(300),
  // On a failure: precisely what to fix, so the user can hand it straight back
  // to the agent. On a pass: what was checked.
  report: z.string().min(1),
});

type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

export interface TaskValidatorOptions {
  agentManager: Pick<AgentManager, "runAgent" | "archiveAgent">;
  createAgent: BoundCreateAgentCommand;
  taskBoardService: TaskBoardService;
  projectRegistry: ProjectRegistry;
  providerModel?: string;
  logger: pino.Logger;
}

export interface TaskValidationOutcome {
  task: KanbanTask;
  passed: boolean;
}

/**
 * The final check behind the "Valider la tâche" bar.
 *
 * Pressing that bar does NOT complete a task. It spawns a short-lived reviewer
 * in the very working tree where the work happened, which re-reads the original
 * request, exercises the result, runs the project's tests and looks for
 * regressions. Only a clean verdict moves the card to "Terminée"; a failed one
 * leaves it in "En cours" with a report saying exactly what to fix.
 *
 * One check at a time per task: a second press while one is running is ignored
 * rather than queued, so the user cannot stack reviewers on the same card.
 */
export class TaskValidator {
  private readonly agentManager: Pick<AgentManager, "runAgent" | "archiveAgent">;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly providerModel: string;
  private readonly logger: pino.Logger;
  // Keyed `${projectId}:${taskId}`; concurrent presses share the same run.
  private readonly inflight = new Map<string, Promise<TaskValidationOutcome>>();

  constructor(options: TaskValidatorOptions) {
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.providerModel = options.providerModel ?? DEFAULT_VALIDATION_PROVIDER_MODEL;
    this.logger = options.logger.child({ module: "task-validator" });
  }

  async validate(projectId: string, taskId: string): Promise<TaskValidationOutcome> {
    const key = `${projectId}:${taskId}`;
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const run = this.validateInner(projectId, taskId).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async validateInner(projectId: string, taskId: string): Promise<TaskValidationOutcome> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    // Already shipped or already finished: nothing to check.
    if (task.column === "done" || task.column === "deployed") {
      return { task, passed: true };
    }

    // Check in the working tree the task actually ran in, so the reviewer sees
    // the real result. Fall back to the project root for tasks that ran in place.
    const project = await this.projectRegistry.get(projectId);
    const folder = board.folders.find((entry) => entry.id === task.folderId);
    const cwd = folder?.worktreeCwd ?? project?.rootPath ?? null;
    if (!cwd) {
      throw new TaskBoardServiceError(
        "task_validate_no_cwd",
        "Cannot resolve a working directory to check this task in",
      );
    }

    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      validation: { state: "running" as const },
    }));

    const verdict = await this.runValidationAgent({ cwd, task });
    const checkedAt = new Date().toISOString();

    if (!verdict) {
      // The reviewer produced nothing usable. That is NOT a pass: leaving the
      // card in "En cours" is the safe outcome.
      const patched = await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
        ...current,
        validation: {
          state: "failed" as const,
          summary: "Le contrôle final n'a pas pu conclure.",
          report:
            "L'agent de vérification n'a pas rendu de verdict exploitable. La tâche reste « En cours » ; relancez la validation ou demandez à l'agent de terminer son travail.",
          checkedAt,
        },
      }));
      return { task: patched, passed: false };
    }

    if (!verdict.passed) {
      const patched = await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
        ...current,
        progress: "blocked" as const,
        validation: {
          state: "failed" as const,
          summary: verdict.summary,
          report: verdict.report,
          checkedAt,
        },
      }));
      this.logger.info({ projectId, taskId }, "Task validation failed");
      return { task: patched, passed: false };
    }

    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      progress: null,
      validation: {
        state: "passed" as const,
        summary: verdict.summary,
        report: verdict.report,
        checkedAt,
      },
    }));
    const moved = await this.taskBoardService.transitionTask(projectId, taskId, "done");
    const validated = moved.tasks.find((entry) => entry.id === taskId);
    this.logger.info({ projectId, taskId }, "Task validation passed, task completed");
    return { task: validated ?? task, passed: true };
  }

  private async runValidationAgent(input: {
    cwd: string;
    task: KanbanTask;
  }): Promise<ValidationVerdict | null> {
    const { task } = input;
    const basePrompt = [
      "Tu es un relecteur exigeant. Une tâche de développement vient d'être réalisée dans ce dépôt et l'utilisateur demande le contrôle final avant de la considérer comme terminée.",
      "",
      "Demande initiale :",
      '"""',
      task.title,
      task.description ?? "",
      '"""',
      "",
      "Ta mission :",
      "1. Vérifier que la demande initiale est réellement satisfaite, dans son intégralité.",
      "2. Contrôler que ce qui a été fait fonctionne (lis le code, exécute ce qui doit l'être).",
      "3. Lancer les vérifications et tests du projet qui couvrent la zone modifiée.",
      "4. Chercher les régressions : ce qui marchait avant doit marcher encore.",
      "5. Vérifier qu'aucune erreur bloquante ne subsiste.",
      "",
      "Tu peux lire les fichiers et lancer des commandes de vérification. NE MODIFIE RIEN : tu contrôles, tu ne corriges pas.",
      "",
      "Règle absolue : en cas de doute, réponds passed=false. Un faux « c'est bon » livre du travail cassé ; un faux « à revoir » coûte seulement une relecture.",
      "",
      "Réponds avec :",
      "- passed : true UNIQUEMENT si la demande est satisfaite et que rien n'est cassé.",
      "- summary : une seule phrase de verdict.",
      "- report : en cas d'échec, la liste précise de ce qui manque ou ne va pas, et les corrections à apporter. En cas de succès, ce que tu as vérifié et comment.",
    ].join("\n");

    let agentId: string | null = null;
    try {
      const created = await this.createAgent({
        kind: "mcp",
        provider: this.providerModel,
        cwd: input.cwd,
        title: "Contrôle final",
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
        schema: ValidationVerdictSchema,
        schemaName: "ValidationVerdict",
      });
      let first = true;
      return await getStructuredAgentResponse({
        caller: async (nextPrompt) => {
          const prompt = first ? initialPrompt : nextPrompt;
          first = false;
          if (!agentId) {
            throw new Error("Validation agent missing");
          }
          const run = await this.agentManager.runAgent(agentId, prompt);
          return resolveFinalText(run.timeline, run.finalText);
        },
        prompt: basePrompt,
        schema: ValidationVerdictSchema,
        maxRetries: 1,
        schemaName: "ValidationVerdict",
      });
    } catch (error) {
      this.logger.warn({ err: error, taskId: task.id }, "Validation agent failed");
      return null;
    } finally {
      if (agentId) {
        try {
          await this.agentManager.archiveAgent(agentId);
        } catch {
          // Ignore cleanup errors for internal validation agents.
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
