import type pino from "pino";
import {
  CONDUCTOR_PROJECT_ID_LABEL,
  CONDUCTOR_PROVIDER_LABEL,
  CONDUCTOR_ROLE_LABEL,
  CONDUCTOR_ROLE_VALUE,
} from "@getpaseo/protocol/agent-labels";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { isPaseoDeployRoot } from "../../utils/paseo-deploy.js";

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

type ConductorProvider = "claude/claude-opus-4-8" | "codex/gpt-5.4";

/**
 * Model the Claude conductor runs on. Pinned on purpose: the conductor is a
 * router, not a coder, so it must NOT inherit the Claude catalog default (Opus 5
 * with the 1M window) that code tasks want. Only fills the blank — the composer's
 * native model menu can still move a live conductor to any other Claude model.
 */
const CLAUDE_CONDUCTOR_MODEL = "claude-opus-4-8";
const CLAUDE_CONDUCTOR_PROVIDER: ConductorProvider = "claude/claude-opus-4-8";
const DEFAULT_CONDUCTOR_PROVIDER: ConductorProvider = CLAUDE_CONDUCTOR_PROVIDER;
const CODEX_CONDUCTOR_PROVIDER: ConductorProvider = "codex/gpt-5.4";

// COMPAT(conductorClaudeModel): until v0.2.3 the Claude conductor was created on
// the bare "sonnet" alias. That string is persisted in two places we do not
// migrate — the provider label of every existing conductor record and its
// `config.model` — and old clients still send it over the wire. Both are accepted
// and mapped onto the current Claude conductor. Drop when floor >= v0.2.3 AND
// every stored conductor has been re-locked (see `conductorConfigIsCurrent`).
const LEGACY_CLAUDE_CONDUCTOR_PROVIDER = "claude/sonnet";
const LEGACY_CLAUDE_CONDUCTOR_MODEL = "sonnet";

/**
 * Thinking effort a Claude conductor starts on. Without an explicit id the model
 * catalog falls back to the FIRST effort level it declares — "low" — which is the
 * wrong default for an agent whose entire job is to read a project, split it into
 * tasks and route them. An explicit user choice still wins: this only fills the
 * blank.
 */
const CONDUCTOR_CLAUDE_THINKING_OPTION_ID = "high";

/**
 * The ONLY paseo MCP tools the "chef d'orchestre" is allowed to use. Its whole
 * job is to manage the kanban board — everything else is off-limits. This is the
 * source of truth for the allowlist: any paseo tool NOT named here is hard-blocked
 * for the conductor (see `CONDUCTOR_DISALLOWED_PASEO_TOOLS`).
 *
 * `list_task_boards` / `list_tasks` are read-only board tools the conductor needs
 * to locate the right project before creating or editing tasks.
 */
export const CONDUCTOR_ALLOWED_PASEO_TOOLS: readonly string[] = [
  "list_task_boards",
  "list_tasks",
  "create_task",
  "update_task",
  "move_task",
  "delete_task",
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
 * Folders are gone from the product — a project has exactly one task list, minted
 * by the server on demand — so the folder tools are blocked here too: nothing in
 * the UI could show or manage a folder the conductor invented.
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
  "create_task_folder",
  "create_terminal",
  "create_worktree",
  "delete_schedule",
  "delete_task_folder",
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
 * per-project agent that manages the kanban board via the paseo task tools.
 *
 * Its first move on every message is a TRIAGE, not a create_task: only a request
 * for ACTION becomes a card. A question is answered in conversation, an ambiguous
 * message is answered plus an offer, and board upkeep (rename, move, delete,
 * list) is a direct tool call. The conductor used to mint a card for literally
 * every message, which buried the board under cards that were really questions.
 * See docs/task-board-cycle.md ("Ce qui crée une carte").
 */
/**
 * The conductor wears one of two hats, chosen by the project it runs on:
 *
 * - On EVERY OTHER project it is a board manager: it never touches code, it turns
 *   every action request into a card (`conductorBoardManagerSystemPrompt`), and
 *   its edit/shell/subagent tools are stripped (`CONDUCTOR_DISALLOWED_TOOLS`).
 *
 * - On the Paseo repo itself (`isPaseoDeployRoot(project.rootPath)`) it is a FULL
 *   agent (`conductorFullAgentSystemPrompt`): it executes orders directly — edit,
 *   run commands, publish — like a normal global agent, with no tool lock.
 *
 * The switch keys off the project's checkout path, the same signal the deploy
 * pipeline already trusts to recognise "this is Paseo" — never a remote URL,
 * which projects do not even persist. `isSelf` is threaded through config build
 * and the relock/current checks so a full-agent conductor is not perpetually
 * seen as "stale" and rewritten back to the locked manager shape.
 */
function conductorSystemPrompt(projectId: string, isSelf: boolean): string {
  return isSelf
    ? conductorFullAgentSystemPrompt(projectId)
    : conductorBoardManagerSystemPrompt(projectId);
}

/**
 * Full-agent prompt used ONLY on the Paseo repo itself. Here the conductor is not
 * a router but a hands-on agent: it carries out the user's orders directly (edit
 * code, run commands, publish) instead of minting a card. It still knows the
 * board and manages it when explicitly asked. Deploy/restart discretion mirrors
 * the repo's standing directive: commit + push freely, never deploy or restart
 * the daemon on its own initiative.
 */
function conductorFullAgentSystemPrompt(projectId: string): string {
  return [
    "Tu es le « chef d'orchestre » du projet Paseo lui-même (ce dépôt).",
    `L'identifiant du projet est : ${projectId}. Passe TOUJOURS ce même projectId à chaque outil du tableau.`,
    "",
    "RÈGLE PARTICULIÈRE À PASEO — TU ES UN AGENT COMPLET :",
    "Contrairement aux chefs d'orchestre des autres projets, tu n'es PAS limité à",
    "la gestion du tableau. Sur ce dépôt, tu es un agent à part entière, comme un",
    "agent global : quand l'utilisateur te demande une action (corriger un bug,",
    "modifier le code, publier, etc.), tu la RÉALISES toi-même directement, au lieu",
    "de créer une carte. Tu as accès aux outils d'édition, de terminal et de lecture",
    "du code : sers-t'en.",
    "",
    "TU GARDES LE TABLEAU SOUS LA MAIN :",
    "Tu peux toujours gérer le tableau via les outils paseo (list_tasks, create_task,",
    "update_task, move_task, delete_task) : crée ou range une carte quand c'est",
    "l'intention réelle de l'utilisateur (« ajoute une tâche pour… », « range le",
    "tableau »). Mais une simple demande d'action n'a plus besoin de devenir une",
    "carte : fais le travail.",
    "",
    "ENREGISTRER OUI, PUBLIER NON SANS ACCORD :",
    "Après une modification de code, tu ENREGISTRES (commit) et tu SAUVEGARDES",
    "(push sur la branche) pour ne rien perdre. Mais tu ne DÉPLOIES JAMAIS de ta",
    "propre initiative : pas de reconstruction du site ni de publication tant que",
    "l'utilisateur ne te le demande pas explicitement (« déploie », « publie »,",
    "« mets en ligne ») ou ne clique pas « Publier ». Les commits non déployés",
    "apparaissent dans sa fenêtre « À déployer » : c'est le comportement voulu.",
    "Ne redémarre JAMAIS le daemon (port 6767) sans accord explicite : cela tuerait",
    "les agents en cours, dont potentiellement toi-même.",
    "",
    "FORME DE TA RÉPONSE :",
    "Rends compte simplement, en français clair, de ce que tu as fait. Pas de",
    "gabarit rigide imposé : adapte-toi à la demande.",
  ].join("\n");
}

function conductorBoardManagerSystemPrompt(projectId: string): string {
  return [
    "Tu es le « chef d'orchestre » du tableau de tâches (kanban) de ce projet.",
    `L'identifiant du projet est : ${projectId}. Passe TOUJOURS ce même projectId à chaque outil.`,
    "",
    "RÈGLE ABSOLUE — TU NE TOUCHES JAMAIS AU CODE :",
    "Ta SEULE fonction est de gérer le tableau. Tu n'écris jamais de code, tu ne",
    "modifies aucun fichier, tu ne lances aucune commande : ni commit, ni push, ni",
    "build, ni test, ni déploiement, ni terminal. Tu ne fais pas le travail",
    "toi-même et tu ne le confies pas non plus à un autre agent que tu lancerais :",
    "tu te contentes de créer, modifier, déplacer ou supprimer des tâches. Les",
    "outils d'édition, de shell et de lancement d'agents te sont",
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
    "- list_tasks : lister les tâches du tableau.",
    "- create_task : créer une tâche.",
    "- update_task : modifier le titre, la description, les tags, la config d'exécution.",
    "- move_task : déplacer une tâche entre « notes » et « backlog » UNIQUEMENT.",
    "- delete_task : supprimer une tâche.",
    "",
    "RÈGLE PRINCIPALE — TOUT MESSAGE NE DEVIENT PAS UNE CARTE :",
    "Avant toute chose, TRIE le message de l'utilisateur dans l'une de ces quatre",
    "familles, puis applique EXACTEMENT le comportement de la famille choisie.",
    "",
    "1) QUESTION ou DEMANDE D'INFORMATION → tu réponds, tu ne crées AUCUNE carte.",
    "Exemples : « comment ça marche ? », « où en est la tâche X ? », « qu'est-ce que",
    "ça veut dire ? », « combien de cartes sont en attente ? », « pourquoi ce",
    "comportement ? », « c'est quoi la différence entre A et B ? ».",
    "Réponds directement dans la conversation, en français simple. Tu peux lire le",
    "tableau (list_tasks) ou le code (Read/Grep/Glob) pour répondre juste — lire",
    "n'est pas agir. Ne crée pas de carte « pour garder une trace » : une question",
    "posée et répondue ne laisse rien à faire.",
    "",
    "2) DEMANDE D'ACTION → tu crées la ou les cartes, comme avant.",
    "Exemples : « corrige le graphe pour qu'il soit en pleine largeur », « ajoute un",
    "bouton d'export », « modifie la couleur du bandeau », « supprime la section",
    "des favoris », « le bouton ne répond plus » (un bug signalé est une demande de",
    "correction). Découpe la demande en une ou plusieurs tâches claires et crée-les",
    "DIRECTEMENT avec create_task en laissant proposeRun à false (ou absent) : la",
    "tâche apparaît aussitôt dans la colonne « backlog » (À faire). Tu n'as pas",
    "besoin de demander l'autorisation d'AJOUTER une tâche — mais elle s'arrête là,",
    "dans « À faire ».",
    "",
    "3) CAS AMBIGU → tu réponds ET tu proposes, sans créer.",
    "Quand la phrase peut se lire comme un simple constat ou comme une demande",
    "(« le chargement est lent, non ? », « ce libellé n'est pas très clair »),",
    "réponds à la question, puis ajoute UNE seule phrase du type « Souhaitez-vous",
    "que j'en fasse une tâche ? ». Écris-la en DERNIER et sur sa propre ligne :",
    "l'application y accroche un bouton « Oui, fais-en une tâche » qui permet de",
    "confirmer en un clic. Ne crée la carte qu'au message suivant, si",
    "l'utilisateur confirme.",
    "",
    "4) GESTION DU TABLEAU LUI-MÊME → tu utilises l'outil, tu ne crées pas de carte.",
    "Exemples : « renomme la carte X », « déplace la carte Y en À faire »,",
    "« supprime la carte Z », « liste les cartes en attente ». Appelle directement",
    "update_task / move_task / delete_task / list_tasks. Créer une carte « corriger",
    "le titre de la carte X » serait une erreur : fais-le, tout simplement.",
    "",
    "En cas d'hésitation entre « question » et « action », traite le message comme",
    "un cas ambigu (famille 3) : mieux vaut proposer une carte que d'en polluer le",
    "tableau.",
    "",
    "RÈGLE ABSOLUE — LA VALIDATION APPARTIENT À L'UTILISATEUR :",
    "Le cycle du tableau est : À faire → Validé → Planifié → En cours → Terminé →",
    "Déployé. Tu n'as le droit d'écrire QUE dans « notes » et « backlog » (À faire).",
    "Tu ne déposes JAMAIS une tâche dans « Validé », et tu ne l'y déplaces jamais",
    "ensuite, même si l'utilisateur vient de te la demander, même si elle est",
    "urgente, même s'il t'a dit « vas-y » ou « fonce » : « Validé » est le geste par",
    "lequel LUI seul autorise la dépense de quota. Ensuite tout est automatique et",
    "ne t'appartient pas non plus — le planificateur promeut « Validé » en",
    "« Planifié », lance la tâche à l'heure du créneau (« En cours »), l'utilisateur",
    "la marque « Terminé » via « Valider la tâche », et la publication la passe en",
    "« Déployé ».",
    "Si l'utilisateur te demande explicitement de valider, de planifier, de lancer",
    "ou de terminer une tâche, réponds simplement qu'elle est prête dans « À faire »",
    "et qu'il lui suffit de la faire glisser dans « Validé » : l'outil te refusera",
    "de toute façon ce déplacement.",
    "",
    "MODE PROPOSITION (sur demande explicite) :",
    "N'utilise create_task avec proposeRun=true (tâche marquée « en attente de",
    "validation », toujours dans « À faire ») QUE si l'utilisateur emploie",
    "clairement les mots « propose », « proposition » ou « à valider ». Sinon,",
    "création directe.",
    "",
    "FORME DE TA RÉPONSE — ELLE DÉPEND DE LA FAMILLE :",
    "Tu n'es pas un agent d'exécution : tu ne rends jamais compte d'un chantier que",
    "tu aurais mené. Le gabarit long en sections numérotées (« Ce qui est fait »,",
    "« Impact », « Activation & facturation », estimation de temps ou de coût) ne",
    "s'applique JAMAIS à toi, même si un bloc de consignes te le suggère.",
    "- Question, cas ambigu, ou geste sur le tableau : réponds en quelques phrases",
    "  de français simple, sans titres, sans estimation et sans facturation.",
    "- Cartes créées, modifiées, déplacées ou supprimées : termine par un court",
    "  récapitulatif en français, une puce par carte (son titre et ce qui lui est",
    "  arrivé). Rien de plus.",
    "Dans tous les cas, rappelle-toi que tu n'écris pas de code et que tu ne fais",
    "jamais passer une carte en « Validé » : c'est le geste de l'utilisateur.",
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

  async ensureConductorAgent(
    projectId: string,
    requestedProvider?: string,
    options?: { reset?: boolean },
  ): Promise<EnsureConductorResult> {
    const provider = resolveConductorProvider(requestedProvider);
    const inflightKey = `${projectId}:${provider}`;
    const existing = this.inflight.get(inflightKey);
    // A reset must never join an in-flight plain ensure: that would hand back the
    // very agent the user asked to retire. Only plain ensures share.
    if (existing && !options?.reset) {
      return existing;
    }
    const promise = this.ensureConductorAgentInner(
      projectId,
      provider,
      options?.reset === true,
    ).finally(() => {
      if (this.inflight.get(inflightKey) === promise) {
        this.inflight.delete(inflightKey);
      }
    });
    this.inflight.set(inflightKey, promise);
    return promise;
  }

  private async ensureConductorAgentInner(
    projectId: string,
    provider: ConductorProvider,
    reset: boolean,
  ): Promise<EnsureConductorResult> {
    const project = await this.projectRegistry.get(projectId);
    if (!project?.rootPath) {
      throw new Error(`Cannot resolve project root for conductor: ${projectId}`);
    }
    const cwd = project.rootPath;
    // The conductor is a full agent on the Paseo repo itself, a locked board
    // manager everywhere else. Decided by the checkout path, never a remote URL.
    const isSelf = isPaseoDeployRoot(cwd);

    // Persistence-by-label: scan persisted agents for an existing, non-archived
    // conductor for this project. This is what makes the conductor survive
    // daemon restarts without any separate mapping file.
    const records = await this.agentStorage.list();
    const liveConductors = records.filter(
      (record) =>
        !record.archivedAt &&
        record.labels[CONDUCTOR_ROLE_LABEL] === CONDUCTOR_ROLE_VALUE &&
        record.labels[CONDUCTOR_PROJECT_ID_LABEL] === projectId,
    );
    if (reset) {
      // "Réinitialiser": retire every live conductor of this project so the fresh
      // one below starts from an empty context.
      //
      // Retiring means REMOVING THE ROLE LABEL, not archiving. Archiving an agent
      // also archives the provider's own thread, and Codex refuses to resume an
      // archived thread ever again — which turned "start a new conversation" into
      // "destroy the old one, and show 'archived' if anything still points at it".
      // Stripping the label is enough: the scan below stops finding it, while the
      // conversation stays intact and openable from the agent list.
      await this.retireConductors(liveConductors, projectId);
    }
    const found = reset
      ? undefined
      : liveConductors.find((record) => recordMatchesConductorProvider(record, provider));
    if (found) {
      // Persistence-by-label reuses the SAME agent across restarts, so a
      // conductor created before the hard lock existed — or one whose stored
      // config has since drifted — would keep its old, unrestricted config
      // forever. Re-apply the lock to its stored config so the daemon rebuilds a
      // locked session on its next restart. This is why the lock was "deployed
      // but not active": the existing conductor was simply never re-locked.
      await this.relockConductorIfStale(found, projectId, provider, isSelf);
      return { agentId: found.id, workspaceId: found.workspaceId ?? null };
    }

    const providerConfig = buildConductorConfig(projectId, provider, isSelf);
    const created = await this.createAgent({
      kind: "mcp",
      provider,
      cwd,
      title: provider === CODEX_CONDUCTOR_PROVIDER ? "Chef d'orchestre Codex" : "Chef d'orchestre",
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
        [CONDUCTOR_PROVIDER_LABEL]: provider,
      },
      config: providerConfig,
    });

    this.logger.info(
      { projectId, provider, agentId: created.snapshot.id },
      "Created persistent conductor agent",
    );
    return {
      agentId: created.snapshot.id,
      workspaceId: created.snapshot.workspaceId ?? null,
    };
  }

  /**
   * Retires the given conductors by removing the role label from their stored
   * record. The label scan then stops finding them and the next ensure creates a
   * fresh conversation — while the old exchange stays fully intact and readable.
   *
   * Deliberately does NOT archive: archiving also archives the provider's thread
   * (Codex refuses to resume an archived thread), which destroys the very
   * conversation the user only wanted to step away from.
   *
   * Best-effort per agent: a failed rewrite must not block the reset.
   */
  private async retireConductors(records: StoredAgentRecord[], projectId: string): Promise<void> {
    for (const record of records) {
      try {
        const labels = { ...record.labels };
        delete labels[CONDUCTOR_ROLE_LABEL];
        delete labels[CONDUCTOR_PROJECT_ID_LABEL];
        delete labels[CONDUCTOR_PROVIDER_LABEL];
        await this.agentStorage.upsert({ ...record, labels });
        this.logger.info({ projectId, agentId: record.id }, "Retired conductor agent on reset");
      } catch (error) {
        this.logger.warn(
          { err: error, projectId, agentId: record.id },
          "Conductor reset retire failed",
        );
      }
    }
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
    provider: ConductorProvider,
    isSelf: boolean,
  ): Promise<void> {
    const alreadyLocked = conductorConfigIsCurrent(record.config, projectId, provider, isSelf);
    if (alreadyLocked) {
      return;
    }

    const desiredConfig = buildConductorConfig(projectId, provider, isSelf, record.config);
    const updated: StoredAgentRecord = {
      ...record,
      labels: {
        ...record.labels,
        [CONDUCTOR_PROVIDER_LABEL]: provider,
      },
      config: desiredConfig,
    };
    await this.agentStorage.upsert(updated);
    this.logger.info(
      { projectId, provider, agentId: record.id },
      "Re-locked existing conductor config (disallowedTools + system prompt); takes effect on next daemon restart",
    );
  }
}

function resolveConductorProvider(value: string | undefined): ConductorProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_CONDUCTOR_PROVIDER;
  }
  if (
    normalized === "claude" ||
    normalized === CLAUDE_CONDUCTOR_PROVIDER ||
    normalized === LEGACY_CLAUDE_CONDUCTOR_PROVIDER
  ) {
    return CLAUDE_CONDUCTOR_PROVIDER;
  }
  if (normalized === "codex" || normalized === CODEX_CONDUCTOR_PROVIDER) {
    return CODEX_CONDUCTOR_PROVIDER;
  }
  throw new Error(`Unsupported conductor provider: ${value}`);
}

function recordMatchesConductorProvider(
  record: StoredAgentRecord,
  provider: ConductorProvider,
): boolean {
  const labelProvider =
    typeof record.labels[CONDUCTOR_PROVIDER_LABEL] === "string"
      ? record.labels[CONDUCTOR_PROVIDER_LABEL]
      : undefined;
  const storedProvider = labelProvider ?? record.provider;
  return resolveConductorProvider(storedProvider) === provider;
}

function buildConductorConfig(
  projectId: string,
  provider: ConductorProvider,
  isSelf: boolean,
  existing?: StoredAgentRecord["config"],
): Partial<AgentSessionConfig> {
  const base = {
    ...toAgentSessionConfigOverrides(existing),
    systemPrompt: conductorSystemPrompt(projectId, isSelf),
  };
  if (provider === CODEX_CONDUCTOR_PROVIDER) {
    // On Paseo itself the conductor is a full agent: no read-only sandbox, let it
    // edit the repo and run commands like any global Codex agent.
    if (isSelf) {
      return { ...base, approvalPolicy: "on-request", sandboxMode: "workspace-write" };
    }
    return {
      ...base,
      approvalPolicy: "on-request",
      sandboxMode: "read-only",
      networkAccess: false,
    };
  }

  const existingClaudeExtra = isRecord(existing?.extra?.claude) ? existing?.extra?.claude : {};
  return {
    ...base,
    // `base` already carries the stored id when the user picked one, so this only
    // applies to a conductor that never had an explicit level.
    thinkingOptionId: base.thinkingOptionId ?? CONDUCTOR_CLAUDE_THINKING_OPTION_ID,
    model: resolveClaudeConductorModel(base.model),
    extra: {
      ...existing?.extra,
      claude: {
        ...existingClaudeExtra,
        // Full agent on Paseo → no tool lock; board manager elsewhere → hard lock.
        disallowedTools: isSelf ? [] : [...CONDUCTOR_DISALLOWED_TOOLS],
      },
    },
  };
}

function conductorConfigIsCurrent(
  config: StoredAgentRecord["config"] | undefined,
  projectId: string,
  provider: ConductorProvider,
  isSelf: boolean,
): boolean {
  if (config?.systemPrompt !== conductorSystemPrompt(projectId, isSelf)) {
    return false;
  }
  if (provider === CODEX_CONDUCTOR_PROVIDER) {
    if (isSelf) {
      return config.approvalPolicy === "on-request" && config.sandboxMode === "workspace-write";
    }
    return (
      config.approvalPolicy === "on-request" &&
      config.sandboxMode === "read-only" &&
      config.networkAccess === false
    );
  }
  // A conductor persisted before this default existed has no stored id and would
  // otherwise stay on the catalog's "low" forever, since persistence-by-label
  // reuses the same record across restarts.
  if (config.thinkingOptionId == null) {
    return false;
  }
  // Same reasoning for the model: a conductor persisted on the legacy "sonnet"
  // alias (or with no model at all) must be moved onto the pinned conductor model
  // instead of staying on the old default for the life of the record.
  if (config.model == null || config.model === LEGACY_CLAUDE_CONDUCTOR_MODEL) {
    return false;
  }
  const expectedDisallowed = isSelf ? [] : CONDUCTOR_DISALLOWED_TOOLS;
  return sameToolSet(readStoredDisallowedTools(config.extra), expectedDisallowed);
}

/**
 * Model a Claude conductor should carry. An explicit pick from the composer's
 * model menu wins; a blank — or the legacy bare "sonnet" alias, which that menu
 * never offers and so can only come from the old hardcoded default — falls to the
 * pinned conductor model.
 */
function resolveClaudeConductorModel(storedModel: string | null | undefined): string {
  if (!storedModel || storedModel === LEGACY_CLAUDE_CONDUCTOR_MODEL) {
    return CLAUDE_CONDUCTOR_MODEL;
  }
  return storedModel;
}

function toAgentSessionConfigOverrides(
  config: StoredAgentRecord["config"] | undefined,
): Partial<AgentSessionConfig> {
  const overrides: Partial<AgentSessionConfig> = {};
  if (!config) {
    return overrides;
  }
  if (config.modeId != null) overrides.modeId = config.modeId;
  if (config.model != null) overrides.model = config.model;
  if (config.thinkingOptionId != null) overrides.thinkingOptionId = config.thinkingOptionId;
  if (config.featureValues != null) overrides.featureValues = config.featureValues;
  if (config.approvalPolicy != null) overrides.approvalPolicy = config.approvalPolicy;
  if (config.sandboxMode != null) overrides.sandboxMode = config.sandboxMode;
  if (config.networkAccess != null) overrides.networkAccess = config.networkAccess;
  if (config.webSearch != null) overrides.webSearch = config.webSearch;
  if (config.extra != null) overrides.extra = config.extra;
  if (config.systemPrompt != null) overrides.systemPrompt = config.systemPrompt;
  if (config.mcpServers != null) overrides.mcpServers = config.mcpServers;
  return overrides;
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
