import { basename } from "node:path";
import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";
import type { ProjectRegistry } from "../workspace-registry.js";
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
  /** Resolves the project's checkout so the deploy step can name it. */
  projectRegistry: Pick<ProjectRegistry, "get">;
  /** Sends the check prompt into the task agent's own conversation. */
  sendPrompt: (input: { agentId: string; prompt: string }) => Promise<void>;
  /** Calls back once the agent stops working; returns an unsubscribe function. */
  watchAgentIdle: (agentId: string, onIdle: () => void) => () => void;
  logger: pino.Logger;
}

/**
 * The final check behind the "Lancer le contrôle" bar.
 *
 * It is also the ONLY machine-made move to "Terminée" on the whole board: every
 * other column change is the user dragging a card. Pressing the bar hands the
 * card's agent a check-then-deploy prompt, and completion is its last step.
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
  private readonly projectRegistry: TaskValidatorOptions["projectRegistry"];
  private readonly sendPrompt: TaskValidatorOptions["sendPrompt"];
  private readonly watchAgentIdle: TaskValidatorOptions["watchAgentIdle"];
  private readonly logger: pino.Logger;

  constructor(options: TaskValidatorOptions) {
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
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
    // "En cours" is the only column a card may leave for "Terminée", so it is the
    // only column where a final check makes sense. Without this the consent
    // window could be opened on a card whose work never ran (an old client, or a
    // card dragged back out of "En cours" mid-check), and the agent would then be
    // allowed to complete it.
    if (task.column !== "in_progress") {
      throw new TaskBoardServiceError(
        "task_validate_not_started",
        "Cette tâche n'est pas encore en cours : lancez-la avant de demander le contrôle final.",
      );
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

    const project = await this.projectRegistry.get(projectId);
    await this.sendPrompt({
      agentId,
      prompt: buildValidationPrompt({ projectId, task, projectRoot: project?.rootPath ?? null }),
    });
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

/**
 * The check prompt. Beyond verifying the work, it carries the ONE deployment the
 * user delegated: pushing the change onto the project's dev instance on the VPS
 * (`<slug>.haikostudio.cloud`, served by the `autoproject-<slug>` systemd unit).
 * Publishing Paseo itself is explicitly excluded — that stays the user's call
 * through the "À déployer" window.
 */
export function buildValidationPrompt(input: {
  projectId: string;
  task: KanbanTask;
  projectRoot: string | null;
}): string {
  const { projectId, task, projectRoot } = input;
  const slug = projectRoot ? basename(projectRoot).toLowerCase() : null;
  const slugHint = slug ? `« ${slug} » (à confirmer)` : "à retrouver";
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
    "5. Quand tout est vert : enregistre ton travail (commit puis push).",
    "6. DÉPLOIE la modification sur l'instance de développement du projet, sur le VPS (domaine haikostudio.cloud). C'est le seul déploiement que l'utilisateur t'a délégué, et il fait partie du contrôle final :",
    `   • Dépôt principal du projet : ${projectRoot ?? "(inconnu — retrouve-le)"}. Sous-domaine et service attendus : ${slugHint} → https://<slug>.haikostudio.cloud, service systemd « autoproject-<slug> ».`,
    "   • Confirme le nom exact : `systemctl list-units 'autoproject-*' --all` et `ls /etc/caddy/project-autostart.d/`.",
    "   • Si tu as travaillé dans un classeur (worktree/branche) séparé, fusionne d'abord ton travail dans le dépôt principal ci-dessus, sur sa branche courante — c'est ce checkout que sert l'instance dev.",
    "   • Installe les dépendances si le lockfile a changé, puis redémarre : `sudo systemctl restart autoproject-<slug>`.",
    "   • VÉRIFIE que c'est réellement en ligne : `systemctl is-active autoproject-<slug>`, puis `curl -sI https://<slug>.haikostudio.cloud` (réponse 200/3xx attendue). En cas d'échec : `journalctl -u autoproject-<slug> -n 80 --no-pager`, corrige, recommence.",
    "   • Si ce projet n'a AUCUNE instance dev sur le VPS, ne l'invente pas : dis-le en une phrase et passe à l'étape 7.",
    "   • INTERDIT : redémarrer `paseo.service`, lancer `paseo-ship-now.sh` ou `paseo-app-deploy.sh`, toucher à un autre projet. La publication de Paseo lui-même reste la décision de l'utilisateur.",
    "7. Seulement une fois le contrôle vert ET l'instance dev à jour, marque la tâche comme terminée avec l'outil move_task :",
    `   move_task(projectId: "${projectId}", taskId: "${task.id}", column: "done")`,
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
