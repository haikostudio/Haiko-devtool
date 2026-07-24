import type pino from "pino";
import {
  CONDUCTOR_PROJECT_ID_LABEL,
  CONDUCTOR_ROLE_LABEL,
  CONDUCTOR_ROLE_VALUE,
} from "@getpaseo/protocol/agent-labels";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
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
 * The ONLY paseo MCP tools the "chef d'orchestre" is allowed to use. Its whole
 * job is to manage the kanban board — everything else is off-limits. This is the
 * source of truth for the allowlist: any paseo tool NOT named here is hard-blocked
 * for the conductor (see `CONDUCTOR_DISALLOWED_PASEO_TOOLS`).
 *
 * `list_task_boards` / `list_tasks` are read-only board tools the conductor needs
 * to locate the right project/folder before creating or editing tasks.
 */
export const CONDUCTOR_ALLOWED_PASEO_TOOLS: readonly string[] = [
  "list_task_boards",
  "list_tasks",
  "create_task",
  "update_task",
  "move_task",
  "delete_task",
  "create_task_folder",
  "delete_task_folder",
];

/**
 * Built-in (non-MCP) tools the conductor is HARD-BLOCKED from ever using: every
 * surface that could edit files, run shell commands (commit, push, build, test,
 * deploy), or fan work out to a subagent. Read-only tools (Read/Grep/Glob) stay
 * available so the conductor can inspect context and write good task descriptions.
 */
const CONDUCTOR_DISALLOWED_BUILTIN_TOOLS: readonly string[] = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Task",
];

/**
 * Every paseo MCP tool the conductor must NOT use — i.e. the full paseo catalog
 * MINUS `CONDUCTOR_ALLOWED_PASEO_TOOLS`. Kept as an explicit denylist (rather than
 * a wildcard, which the SDK does not support) so the block is auditable. A
 * completeness test enumerates the real tool catalog and fails if a newly added
 * paseo tool is neither allowed nor listed here — so new tools are blocked by
 * default and must be classified on purpose.
 *
 * Beyond code execution, this blocks steering OTHER agents (create/cancel/kill/
 * update/set_agent_mode/send_agent_prompt), approving their permission prompts
 * (respond_to_permission), driving terminals, worktrees, schedules, heartbeats,
 * and workspace renames. None of that is board management.
 */
const CONDUCTOR_DISALLOWED_PASEO_TOOLS: readonly string[] = [
  "archive_agent",
  "archive_worktree",
  "cancel_agent",
  "capture_terminal",
  "create_agent",
  "create_heartbeat",
  "create_schedule",
  "create_terminal",
  "create_worktree",
  "delete_schedule",
  "get_agent_activity",
  "get_agent_status",
  "inspect_provider",
  "inspect_schedule",
  "kill_agent",
  "kill_terminal",
  "list_agents",
  "list_models",
  "list_pending_permissions",
  "list_providers",
  "list_schedules",
  "list_terminals",
  "list_worktrees",
  "pause_schedule",
  "rename_workspace",
  "respond_to_permission",
  "resume_schedule",
  "schedule_logs",
  "send_agent_prompt",
  "send_terminal_keys",
  "set_agent_mode",
  "speak",
  "update_agent",
  "update_schedule",
].map((name) => `mcp__paseo__${name}`);

/**
 * Tools the conductor is HARD-BLOCKED from ever using. `disallowedTools` is
 * enforced by the Claude Agent SDK before any permission prompt, so listing a
 * tool here makes it impossible to call even when the agent runs in a permissive
 * mode. Built-in edit/shell/subagent tools + every non-board paseo tool.
 */
export const CONDUCTOR_DISALLOWED_TOOLS: readonly string[] = [
  ...CONDUCTOR_DISALLOWED_BUILTIN_TOOLS,
  ...CONDUCTOR_DISALLOWED_PASEO_TOOLS,
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
      // Persistence-by-label reuses the SAME agent across restarts, so a
      // conductor created before the hard lock existed — or one whose stored
      // config has since drifted — would keep its old, unrestricted config
      // forever. Re-apply the lock to its stored config so the daemon rebuilds a
      // locked session on its next restart. This is why the lock was "deployed
      // but not active": the existing conductor was simply never re-locked.
      await this.relockConductorIfStale(found, projectId);
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

  /**
   * Re-apply the hard lock (disallowedTools + system prompt) to an already
   * persisted conductor whose stored config is missing or out of date. Rewrites
   * only the `config` field of the stored record — every other field is
   * preserved — so the daemon rebuilds a locked session from disk on its next
   * restart. Idempotent: a conductor that is already locked is left untouched,
   * so this never churns storage or re-creates the agent on the happy path.
   */
  private async relockConductorIfStale(
    record: StoredAgentRecord,
    projectId: string,
  ): Promise<void> {
    const desiredPrompt = conductorSystemPrompt(projectId);
    const storedDisallowed = readStoredDisallowedTools(record.config?.extra);
    const alreadyLocked =
      record.config?.systemPrompt === desiredPrompt &&
      sameToolSet(storedDisallowed, CONDUCTOR_DISALLOWED_TOOLS);
    if (alreadyLocked) {
      return;
    }

    const existingClaudeExtra = isRecord(record.config?.extra?.claude)
      ? record.config?.extra?.claude
      : {};
    const updated: StoredAgentRecord = {
      ...record,
      config: {
        ...record.config,
        systemPrompt: desiredPrompt,
        extra: {
          ...record.config?.extra,
          claude: {
            ...existingClaudeExtra,
            disallowedTools: [...CONDUCTOR_DISALLOWED_TOOLS],
          },
        },
      },
    };
    await this.agentStorage.upsert(updated);
    this.logger.info(
      { projectId, agentId: record.id },
      "Re-locked existing conductor config (disallowedTools + system prompt); takes effect on next daemon restart",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read `extra.claude.disallowedTools` from a stored config, tolerating any shape. */
function readStoredDisallowedTools(
  extra: Record<string, unknown> | null | undefined,
): string[] | undefined {
  if (!isRecord(extra)) {
    return undefined;
  }
  const claude = extra.claude;
  if (!isRecord(claude)) {
    return undefined;
  }
  const tools = claude.disallowedTools;
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools.filter((tool): tool is string => typeof tool === "string");
}

/** True when both lists contain exactly the same tool names, order-independent. */
function sameToolSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) {
    return false;
  }
  const wanted = new Set(b);
  return a.every((tool) => wanted.has(tool));
}
