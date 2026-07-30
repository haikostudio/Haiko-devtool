import { basename } from "node:path";
import type pino from "pino";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { ProjectRegistry } from "../workspace-registry.js";
import { TaskBoardServiceError, type TaskBoardService } from "./service.js";
import { type AgentStopReason, resolveTaskAgentId } from "./task-agent-link.js";
import { isTaskLive } from "./batch-deployer.js";

export interface TaskDeploymentOutcome {
  task: KanbanTask;
  /** True when the deploy prompt was handed to the task's own agent. */
  dispatched: boolean;
  /** Card's current daemon-restart flag, echoed for a re-deploy. */
  needsDaemonRestart: boolean;
}

export interface TaskDeployerOptions {
  taskBoardService: TaskBoardService;
  /** Resolves the project's checkout so the deploy step can name it. */
  projectRegistry: Pick<ProjectRegistry, "get">;
  /** Sends the deploy prompt into the task agent's own conversation. */
  sendPrompt: (input: { agentId: string; prompt: string }) => Promise<void>;
  /** Calls back once the agent stops working; returns an unsubscribe function. */
  watchAgentIdle: (agentId: string, onIdle: (reason?: AgentStopReason) => void) => () => void;
  logger: pino.Logger;
}

/**
 * The deploy action behind "Lancer le déploiement".
 *
 * Symmetric to {@link TaskValidator}: it is the ONLY machine-made move to
 * "Déployée" that an agent may make. Pressing the bar on a finished ("Terminée")
 * card hands the card's own agent a deploy-then-confirm prompt, and the move to
 * "deployed" is its last step.
 *
 * The deployment is NOT hidden: it is a prompt sent to the task's own agent, in
 * the task's own conversation. The user sees the whole thing — what was checked,
 * what was published, where. The agent re-reads the request, confirms the work
 * still runs, deploys it (the project's dev instance; Paseo publishes itself),
 * verifies it is live, and only then moves the card to "deployed" itself — while
 * reporting whether the change needs a daemon restart to take effect.
 *
 * Pressing the bar is what authorizes that move: `deployment.state === "running"`
 * is the open consent window that lets `move_task` accept "deployed" for this one
 * card (see AGENT_WRITABLE_TASK_COLUMNS in paseo-tools.ts). Outside that window an
 * agent still may not deploy a card.
 *
 * The window stays open while the agent works or waits for an answer. It closes
 * only after the card carries proof that the result is live.
 */
export class TaskDeployer {
  private readonly taskBoardService: TaskBoardService;
  private readonly projectRegistry: TaskDeployerOptions["projectRegistry"];
  private readonly sendPrompt: TaskDeployerOptions["sendPrompt"];
  private readonly watchAgentIdle: TaskDeployerOptions["watchAgentIdle"];
  private readonly logger: pino.Logger;

  constructor(options: TaskDeployerOptions) {
    this.taskBoardService = options.taskBoardService;
    this.projectRegistry = options.projectRegistry;
    this.sendPrompt = options.sendPrompt;
    this.watchAgentIdle = options.watchAgentIdle;
    this.logger = options.logger.child({ module: "task-deployer" });
  }

  async deploy(projectId: string, taskId: string): Promise<TaskDeploymentOutcome> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new TaskBoardServiceError("task_not_found", `Task not found: ${taskId}`);
    }
    // Already online: nothing to do. The column alone does not say that any more
    // — "À déployer" is the queue a finished card waits in — so the truth is the
    // live stamp itself.
    if (isTaskLive(task)) {
      return { task, dispatched: false, needsDaemonRestart: task.needsDaemonRestart ?? false };
    }
    // A card may only be deployed once its work is finished: either it just
    // reached "Terminée", or it is already waiting in the "À déployer" queue.
    // Without this the consent window could be opened on a card whose work never
    // finished, and the agent would then be allowed to deploy it.
    if (task.column !== "done" && task.column !== "deployed") {
      throw new TaskBoardServiceError(
        "task_deploy_not_done",
        "Cette tâche n'est pas terminée : terminez-la avant de lancer le déploiement.",
      );
    }

    const agentId = resolveTaskAgentId(task);
    if (!agentId) {
      throw new TaskBoardServiceError(
        "task_deploy_no_agent",
        "Aucun agent n'est rattaché à cette tâche : impossible de déployer.",
      );
    }

    // Open the consent window BEFORE the prompt leaves, so the agent can already
    // move the card on its very first turn if everything is live.
    const patched = await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      deployment: { state: "running" as const, startedAt: new Date().toISOString() },
    }));

    // Watch before sending: the agent may finish its turn faster than we could
    // subscribe afterwards.
    this.watchAgentIdle(agentId, (reason = "idle") => {
      void this.settleWindow(projectId, taskId, reason).catch((error) => {
        this.logger.error({ err: error, projectId, taskId }, "Failed to confirm deployment window");
      });
    });

    const project = await this.projectRegistry.get(projectId);
    await this.sendPrompt({
      agentId,
      prompt: buildDeployPrompt({ projectId, task, projectRoot: project?.rootPath ?? null }),
    });
    this.logger.info({ projectId, taskId, agentId }, "Deploy prompt handed to the task agent");
    return {
      task: patched,
      dispatched: true,
      needsDaemonRestart: task.needsDaemonRestart ?? false,
    };
  }

  /**
   * The agent stopped talking. Close the window only when the card itself proves
   * the work is live. Otherwise it may simply be waiting for the user, so the
   * progress indicator must remain visible.
   */
  private async settleWindow(
    projectId: string,
    taskId: string,
    reason: AgentStopReason,
  ): Promise<void> {
    const board = await this.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.id === taskId);
    if (!task || task.deployment?.state !== "running") {
      return;
    }
    // The deploy succeeded either when the agent moved the card to "deployed" or
    // when the work is demonstrably live (a deployedUrl was stamped). Treating a
    // live URL as success keeps the window from resetting to a fresh, clickable
    // "Lancer le déploiement" on a card whose work is already published.
    const deployed = isTaskLive(task);
    if (!deployed && reason === "idle") {
      return;
    }
    await this.taskBoardService.patchTask(projectId, taskId, (current) => ({
      ...current,
      deployment: deployed
        ? { state: "deployed" as const, startedAt: current.deployment?.startedAt }
        : {
            state: "failed" as const,
            startedAt: current.deployment?.startedAt,
            summary:
              reason === "error"
                ? "La publication s'est arrêtée sur une erreur confirmée."
                : "La publication s'est arrêtée avant de pouvoir confirmer la mise en ligne.",
          },
    }));
  }
}

/** True while the user's press authorizes this card's agent to deploy it. */
export function isDeploymentWindowOpen(task: KanbanTask): boolean {
  return task.deployment?.state === "running";
}

/**
 * The deploy prompt. It is handed to a FINISHED card's own agent, and it is the
 * ONE moment of the card's life where an agent verifies the work: finishing a card
 * is now a pure column move (see TaskValidator), so nothing has been re-checked
 * since the execution turn itself. Verification therefore lives here, right before
 * the code goes online — which is also the only place it pays for itself, since a
 * card the user never queues never spends a check.
 *
 * It also carries the one honest signal we cannot infer from the outside: whether
 * the change needs a daemon restart to take effect.
 *
 * For Paseo itself publication is the batch button on the "À déployer" column
 * (which builds the web app AND the daemon, then restarts it as its last step),
 * so the agent must NOT run any publish script or restart `paseo.service`; it
 * confirms the build is live and reports the restart need. In every case the last
 * step is `move_task(..., "deployed", needsDaemonRestart)`, which the open consent
 * window authorizes.
 */
export function buildDeployPrompt(input: {
  projectId: string;
  task: KanbanTask;
  projectRoot: string | null;
}): string {
  const { projectId, task, projectRoot } = input;
  const slug = projectRoot ? basename(projectRoot).toLowerCase() : null;
  const slugHint = slug ? `« ${slug} » (à confirmer)` : "à retrouver";
  return [
    "L'utilisateur demande le DÉPLOIEMENT de cette tâche déjà terminée.",
    "",
    "Demande initiale :",
    '"""',
    task.title,
    task.description ?? "",
    '"""',
    "",
    "Procède dans cet ordre :",
    "Règle de réponse pendant tout ce déploiement : travaille silencieusement du début à la fin.",
    "N'envoie AUCUN compte-rendu intermédiaire : une seule réponse finale, une fois la mise en ligne confirmée (ou une seule réponse de blocage si tu es réellement empêché d'avancer seul).",
    "",
    "1. CONTRÔLE le travail avant de le mettre en ligne — c'est ici, et nulle part ailleurs, que la vérification a lieu :",
    "   • Relis la demande initiale ci-dessus et vérifie qu'elle est réellement satisfaite, dans son intégralité.",
    "   • Vérifie que ce qui a été fait fonctionne : relis le code, lance le typecheck, le lint et les tests qui couvrent la zone modifiée.",
    "   • Cherche les régressions : ce qui marchait avant doit marcher encore.",
    "   • S'il reste quoi que ce soit à corriger, CORRIGE-LE toi-même, enregistre (commit puis push), puis reprends ce contrôle depuis le début.",
    "   • Si le fonctionnement est OK, tu peux lancer le déploiement.",
    "2. DÉPLOIE la modification sur l'instance de développement du projet, sur le VPS (domaine haikostudio.cloud) :",
    `   • Dépôt principal du projet : ${projectRoot ?? "(inconnu — retrouve-le)"}. Sous-domaine et service attendus : ${slugHint} → https://<slug>.haikostudio.cloud, service systemd « autoproject-<slug> ».`,
    "   • Confirme le nom exact : `systemctl list-units 'autoproject-*' --all` et `ls /etc/caddy/project-autostart.d/`.",
    "   • Installe les dépendances si le lockfile a changé, puis redémarre : `sudo systemctl restart autoproject-<slug>`.",
    "   • VÉRIFIE que c'est réellement en ligne : `systemctl is-active autoproject-<slug>`, puis `curl -sI https://<slug>.haikostudio.cloud` (réponse 200/3xx attendue). En cas d'échec : `journalctl -u autoproject-<slug> -n 80 --no-pager`, corrige, recommence.",
    "   • Si ce projet n'a AUCUNE instance dev sur le VPS, ne l'invente pas : dis-le en une phrase et passe à l'étape 3.",
    "   • Cas particulier — si ce projet est Paseo lui-même : NE lance aucun script de publication et NE redémarre PAS `paseo.service`. Sa publication passe par le bouton « Tout déployer » de la colonne « À déployer », qui publie tout le lot d'un coup. Contente-toi de vérifier/confirmer l'état en ligne.",
    "   • INTERDIT dans tous les cas : toucher à un autre projet que celui de cette tâche.",
    "3. Une fois le déploiement confirmé en ligne, marque la tâche comme déployée avec l'outil move_task (colonne « deployed » : la carte y est peut-être déjà — l'appel l'estampille alors « en ligne »). Renseigne `needsDaemonRestart` :",
    "   • `true` si la modification ne prend effet qu'après un redémarrage du démon/service (typiquement un changement côté serveur). Le redémarrage reste à la décision de l'utilisateur : ne le déclenche PAS toi-même, la carte affichera simplement un indicateur.",
    "   • `false` si le déploiement suffit (changement côté interface uniquement, déjà pris en compte au redémarrage du service ci-dessus).",
    `   move_task(projectId: "${projectId}", taskId: "${task.id}", column: "deployed", needsDaemonRestart: <true|false>)`,
    "",
    "Si le contrôle ou le déploiement échoue et que tu ne peux pas le corriger seul, NE marque pas la tâche déployée : explique en clair ce qui bloque.",
    "Règle absolue : en cas de doute, ne déploie pas. Un faux « c'est en ligne » est pire qu'un doute annoncé.",
  ].join("\n");
}
