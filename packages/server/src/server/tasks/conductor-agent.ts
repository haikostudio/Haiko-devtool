import type pino from "pino";
import {
  CONDUCTOR_PROJECT_ID_LABEL,
  CONDUCTOR_ROLE_LABEL,
  CONDUCTOR_ROLE_VALUE,
} from "@getpaseo/protocol/agent-labels";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";

export interface ConductorAgentServiceOptions {
  createAgent: BoundCreateAgentCommand;
  agentStorage: AgentStorage;
  projectRegistry: ProjectRegistry;
  logger: pino.Logger;
}

export interface EnsureConductorResult {
  agentId: string;
  workspaceId: string | null;
}

/**
 * French system prompt for the board's "chef d'orchestre". It is a persistent,
 * per-project agent that manages the kanban board via the paseo task tools. Its
 * core job: turn EVERY user request into one or more real tasks added directly
 * to the board's list — the user does not want to validate each one by hand.
 */
function conductorSystemPrompt(projectId: string): string {
  return [
    "Tu es le « chef d'orchestre » du tableau de tâches (kanban) de ce projet.",
    `L'identifiant du projet est : ${projectId}. Passe TOUJOURS ce même projectId à chaque outil.`,
    "",
    "Tu pilotes le tableau via les outils paseo :",
    "- list_tasks : lister les tâches et dossiers du tableau.",
    "- create_task : créer une tâche.",
    "- update_task : modifier le titre, la description, les tags, la config d'exécution.",
    "- move_task : déplacer une tâche entre colonnes (backlog, validated, scheduled, in_progress, done).",
    "- delete_task : supprimer une tâche.",
    "- create_task_folder : créer un dossier.",
    "- delete_task_folder : supprimer un dossier.",
    "",
    "RÈGLE PRINCIPALE — CHAQUE DEMANDE = UNE OU PLUSIEURS TÂCHES DANS LA LISTE :",
    "Interprète CHAQUE message de l'utilisateur comme une intention d'ajouter du",
    "travail au tableau. Découpe-le en une ou plusieurs tâches claires et crée-les",
    "DIRECTEMENT dans la liste avec create_task en laissant proposeRun à false (ou",
    "absent) : la tâche apparaît aussitôt dans la colonne « backlog » (À faire).",
    "N'attends AUCUNE validation manuelle — l'utilisateur ne veut pas approuver",
    "chaque tâche à la main.",
    "Utilise update_task / move_task / delete_task quand il demande de modifier,",
    "déplacer ou supprimer une tâche existante.",
    "",
    "COLONNE DE DÉPÔT PAR DÉFAUT :",
    "Dépose les nouvelles tâches dans « backlog » (À faire) par défaut. Si",
    "l'utilisateur indique une autre colonne de destination pour la suite (par ex.",
    "« désormais mets-les dans Validé », « range-les directement en Programmé »),",
    "RETIENS ce choix et applique-le à toutes les créations suivantes de la",
    "conversation, jusqu'à ce qu'il en change.",
    "",
    "MODE PROPOSITION (sur demande explicite) :",
    "N'utilise create_task avec proposeRun=true (proposition en attente",
    "d'approbation, colonne « Programmé ») QUE si l'utilisateur emploie clairement",
    "les mots « propose », « proposition » ou « à valider ». Sinon, création directe.",
    "",
    "RÉCAPITULATIF EN FIN DE LOT :",
    "Après avoir traité une demande, termine par un court récapitulatif en français",
    "listant les tâches créées (une puce par titre) et, le cas échéant, celles",
    "modifiées, déplacées ou supprimées. Reste concis.",
  ].join("\n");
}

export class ConductorAgentService {
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: ProjectRegistry;
  private readonly logger: pino.Logger;
  // Serializes concurrent ensure calls per project so we never create two
  // conductors for the same project when two clients open the panel at once.
  private readonly inflight = new Map<string, Promise<EnsureConductorResult>>();

  constructor(options: ConductorAgentServiceOptions) {
    this.createAgent = options.createAgent;
    this.agentStorage = options.agentStorage;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger;
  }

  async ensureConductorAgent(projectId: string): Promise<EnsureConductorResult> {
    const existing = this.inflight.get(projectId);
    if (existing) {
      return existing;
    }
    const promise = this.ensureConductorAgentInner(projectId).finally(() => {
      this.inflight.delete(projectId);
    });
    this.inflight.set(projectId, promise);
    return promise;
  }

  private async ensureConductorAgentInner(projectId: string): Promise<EnsureConductorResult> {
    const project = await this.projectRegistry.get(projectId);
    if (!project?.rootPath) {
      throw new Error(`Cannot resolve project root for conductor: ${projectId}`);
    }
    const cwd = project.rootPath;

    // Persistence-by-label: scan persisted agents for an existing, non-archived
    // conductor for this project. This is what makes the conductor survive
    // daemon restarts without any separate mapping file.
    const records = await this.agentStorage.list();
    const found = records.find(
      (record) =>
        !record.archivedAt &&
        record.labels[CONDUCTOR_ROLE_LABEL] === CONDUCTOR_ROLE_VALUE &&
        record.labels[CONDUCTOR_PROJECT_ID_LABEL] === projectId,
    );
    if (found) {
      return { agentId: found.id, workspaceId: found.workspaceId ?? null };
    }

    const created = await this.createAgent({
      kind: "mcp",
      provider: "claude/sonnet",
      cwd,
      title: "Chef d'orchestre",
      background: true,
      notifyOnFinish: false,
      unattended: false,
      promptFailure: "return-error",
      // NOT internal: internal agents are not persisted, so a conductor must be
      // a normal persisted agent to survive restarts. It is hidden from tabs by
      // its label instead (see agent listing filters).
      internal: false,
      labels: {
        [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE,
        [CONDUCTOR_PROJECT_ID_LABEL]: projectId,
      },
      config: { systemPrompt: conductorSystemPrompt(projectId) },
    });

    this.logger.info(
      { projectId, agentId: created.snapshot.id },
      "Created persistent conductor agent",
    );
    return {
      agentId: created.snapshot.id,
      workspaceId: created.snapshot.workspaceId ?? null,
    };
  }
}
