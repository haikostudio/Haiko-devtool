import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import { TaskBoardServiceError, type TaskBoardService } from "./service.js";

export interface TaskValidationOutcome {
  task: KanbanTask;
  /** True when the card was already finished, so nothing had to be checked. */
  passed: boolean;
  /** True when the check prompt was handed to the task's own agent. */
  dispatched: boolean;
}

/** Minimal slice of AgentManager the idle watcher needs. */
export type ValidationAgentWatcher = Pick<AgentManager, "subscribe" | "getAgent">;

export interface TaskValidatorOptions {
  taskBoardService: TaskBoardService;
  /** Sends the check prompt into the task agent's own conversation. */
  sendPrompt: (input: { agentId: string; prompt: string }) => Promise<void>;
  /** Calls back once the agent stops working; returns an unsubscribe function. */
  watchAgentIdle: (agentId: string, onIdle: () => void) => () => void;
  logger: pino.Logger;
}

/**
 * The final check behind the "Lancer le contrôle" bar.
 *
 * The check is NOT a hidden reviewer: it is a prompt sent to the task's own
 * agent, in the task's own conversation. The user sees the whole thing happen —
 * what was verified, what failed, what got fixed. The agent re-reads the
 * original request, exercises the work, runs the project's checks, FIXES what it
 * finds, and only then completes the card itself.
 *
 * Pressing the bar is what authorizes that completion: `validation.state ===
 * "running"` is the open consent window that lets `move_task` accept "done" for
 * this one card (see AGENT_WRITABLE_TASK_COLUMNS in paseo-tools.ts). Outside
 * that window an agent still may not finish a task.
 *
 * If the agent stops without completing the card, the window closes on its own
 * so the bar is immediately pressable again — a check can never get stuck.
 */
export class TaskValidator {
  private readonly taskBoardService: TaskBoardService;
  private readonly sendPrompt: TaskValidatorOptions["sendPrompt"];
  private readonly watchAgentIdle: TaskValidatorOptions["watchAgentIdle"];
  private readonly logger: pino.Logger;

  constructor(options: TaskValidatorOptions) {
    this.taskBoardService = options.taskBoardService;
    this.sendPrompt = options.sendPrompt;
    this.watchAgentIdle = options.watchAgentIdle;
    this.logger = options.logger.child({ module: "task-validator" });
  }

  async validate(projectId: string, taskId: string): Promise<TaskValidationOutcome> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    // Already shipped or already finished: nothing to check.
    if (task.column === "done" || task.column === "deployed") {
      return { task, passed: true, dispatched: false };
    }

    const agentId = resolveTaskAgentId(task);
    if (!agentId) {
      throw new TaskBoardServiceError(
        "task_validate_no_agent",
        "Aucun agent n'est rattaché à cette tâche : lancez-la d'abord.",
      );
    }

    // Open the consent window BEFORE the prompt leaves, so the agent can already
    // complete the card on its very first turn if everything checks out.
    const patched = await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      validation: { state: "running" as const, checkedAt: new Date().toISOString() },
    }));

    // Watch before sending: the agent may finish its turn faster than we could
    // subscribe afterwards.
    this.watchAgentIdle(agentId, () => {
      void this.closeWindow(projectId, taskId).catch((error) => {
        this.logger.error({ err: error, projectId, taskId }, "Failed to close validation window");
      });
    });

    await this.sendPrompt({ agentId, prompt: buildValidationPrompt({ projectId, task }) });
    this.logger.info({ projectId, taskId, agentId }, "Validation check handed to the task agent");
    return { task: patched, passed: false, dispatched: true };
  }

  /**
   * The agent stopped talking. Either it completed the card — in which case the
   * check passed — or it did not, and the window must close so the user can
   * press again without waiting on anything.
   */
  private async closeWindow(projectId: string, taskId: string): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task || task.validation?.state !== "running") {
      return;
    }
    const finished = task.column === "done" || task.column === "deployed";
    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      validation: finished
        ? { state: "passed" as const, checkedAt: new Date().toISOString() }
        : null,
    }));
  }
}

/**
 * The pipeline agent holds the task's real conversation (analysis AND execution).
 * Fall back to whatever agent the board has on file for older cards.
 */
export function resolveTaskAgentId(task: KanbanTask): string | null {
  return task.links.taskAgentId ?? task.links.primaryAgentId ?? task.links.agentIds.at(-1) ?? null;
}

/** True while the user's press authorizes this card's agent to complete it. */
export function isValidationWindowOpen(task: KanbanTask): boolean {
  return task.validation?.state === "running";
}

function buildValidationPrompt(input: { projectId: string; task: KanbanTask }): string {
  const { projectId, task } = input;
  return [
    "L'utilisateur demande le CONTRÔLE FINAL de cette tâche avant de la considérer comme terminée.",
    "",
    "Demande initiale :",
    '"""',
    task.title,
    task.description ?? "",
    '"""',
    "",
    "Procède dans cet ordre :",
    "1. Vérifie que la demande initiale est réellement satisfaite, dans son intégralité.",
    "2. Vérifie que ce qui a été fait fonctionne : relis le code, lance le typecheck, le lint et les tests qui couvrent la zone modifiée.",
    "3. Cherche les régressions : ce qui marchait avant doit marcher encore.",
    "4. S'il reste quoi que ce soit à corriger, CORRIGE-LE toi-même, puis reprends la vérification au point 1.",
    "5. Quand — et seulement quand — tout est vert et la demande entièrement satisfaite : enregistre ton travail (commit puis push), et marque la tâche comme terminée avec l'outil move_task :",
    `   move_task(projectId: "${projectId}", taskId: "${task.id}", column: "done")`,
    "   Ne déploie pas et ne publie rien : la mise en ligne reste la décision de l'utilisateur.",
    "",
    "Si tu es bloqué sur quelque chose que tu ne peux pas corriger seul, NE marque pas la tâche terminée : explique en clair ce qui bloque et ce dont tu as besoin.",
    "Règle absolue : en cas de doute, ne termine pas. Un faux « c'est bon » livre du travail cassé ; un doute annoncé ne coûte qu'un aller-retour.",
  ].join("\n");
}

/**
 * Fires `onIdle` the first time the agent stops working after the check prompt.
 * Errors and closures count as "stopped" — a check must never leave the bar
 * waiting on an agent that will never answer.
 */
export function watchAgentIdle(
  agentManager: ValidationAgentWatcher,
  agentId: string,
  onIdle: () => void,
): () => void {
  let sawRunning = agentManager.getAgent(agentId)?.lifecycle === "running";
  let fired = false;
  let unsubscribe: (() => void) | null = null;

  function finish(): void {
    if (fired) {
      return;
    }
    fired = true;
    unsubscribe?.();
    onIdle();
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired || event.type !== "agent_state") {
        return;
      }
      if (event.agent.lifecycle === "running") {
        sawRunning = true;
        return;
      }
      if (event.agent.lifecycle === "closed" || event.agent.lifecycle === "error") {
        finish();
        return;
      }
      if (event.agent.lifecycle === "idle" && sawRunning) {
        finish();
      }
    },
    { agentId, replayState: false },
  );

  if (fired) {
    unsubscribe();
  }
  return () => {
    fired = true;
    unsubscribe?.();
  };
}
