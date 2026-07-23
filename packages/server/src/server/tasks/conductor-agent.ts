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
 * Tools the "chef d'orchestre" is HARD-BLOCKED from ever using. The conductor's
 * only job is to manage the kanban board (create/update/move/delete tasks and
 * folders) — it must NEVER act on the code itself. `disallowedTools` is enforced
 * by the Claude Agent SDK before any permission prompt, so listing a tool here
 * makes it impossible to call, even when the agent runs in a permissive mode.
 *
 * We block every surface that could edit files, run shell commands (commit,
 * push, build, test, deploy), or fan work out to another agent/terminal. The
 * board's own execution pipeline — not the conductor — is what spawns the agents
 * that actually do the work. Read-only tools (Read/Grep/Glob) stay available so
 * the conductor can inspect context and write good task descriptions.
 */
export const CONDUCTOR_DISALLOWED_TOOLS: readonly string[] = [
  // Built-in editing / shell / subagent tools.
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  // Paseo MCP tools that execute code or spawn/steer other agents & terminals.
  "mcp__paseo__create_agent",
  "mcp__paseo__send_agent_prompt",
  "mcp__paseo__create_terminal",
  "mcp__paseo__send_terminal_keys",
  "mcp__paseo__kill_terminal",
  "mcp__paseo__capture_terminal",
  "mcp__paseo__create_worktree",
  "mcp__paseo__archive_worktree",
  "mcp__paseo__create_schedule",
  "mcp__paseo__create_heartbeat",
];

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
    "RÈGLE ABSOLUE — TU NE TOUCHES JAMAIS AU CODE :",
    "Ta SEULE fonction est de gérer le tableau. Tu n'écris jamais de code, tu ne",
    "modifies aucun fichier, tu ne lances aucune commande : ni commit, ni push, ni",
    "build, ni test, ni déploiement, ni terminal. Tu ne fais pas le travail",
    "toi-même et tu ne le confies pas non plus à un autre agent que tu lancerais :",
    "tu te contentes de créer, modifier, déplacer ou supprimer des tâches (et des",
    "dossiers). Les outils d'édition, de shell et de lancement d'agents te sont",
    "d'ailleurs techniquement retirés — si tu ressens le besoin d'agir sur le code,",
    "c'est le signe qu'il faut créer une tâche à la place.",
    "",
    "TOUTE DEMANDE D'ACTION = UNE TÂCHE, JAMAIS UNE EXÉCUTION :",
    "Quand l'utilisateur demande une correction, une fonctionnalité, un changement",
    "de comportement ou n'importe quelle action sur le projet (par ex. « corrige le",
    "graphe pour qu'il soit en pleine largeur »), tu ne la réalises PAS toi-même :",
    "tu crées une tâche claire qui la décrit. C'est l'agent d'exécution de cette",
    "tâche qui fera le travail réel. Ne code jamais, même pour une modification qui",
    "te paraît minuscule.",
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
      config: {
        systemPrompt: conductorSystemPrompt(projectId),
        // Hard-lock the conductor to board management only: block every editing,
        // shell, and agent/terminal-spawning tool so it can never write code,
        // commit, push, or deploy — even under a permissive mode. See
        // CONDUCTOR_DISALLOWED_TOOLS for the rationale.
        extra: { claude: { disallowedTools: [...CONDUCTOR_DISALLOWED_TOOLS] } },
      },
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
