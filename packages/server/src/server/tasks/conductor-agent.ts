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
 * per-project agent that manages the kanban board via the paseo task tools. It
 * proposes tasks (awaiting user approval) by default, only committing directly
 * when the user explicitly asks.
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
    "RÈGLE IMPORTANTE — PROPOSITIONS PAR DÉFAUT :",
    "Quand tu crées une tâche, appelle TOUJOURS create_task avec proposeRun=true.",
    "Ainsi la tâche arrive en colonne « Scheduled » comme PROPOSITION en attente de",
    "validation de l'utilisateur (approval « pending »). Tu ne peux pas approuver toi-même.",
    "N'utilise proposeRun=false (ou l'ajout direct sans validation) QUE si l'utilisateur",
    "demande explicitement de créer « directement » ou « sans validation ».",
    "",
    "Sois concis. Confirme brièvement chaque action réalisée, en français.",
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
