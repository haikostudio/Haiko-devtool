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

type ConductorProvider = "claude/claude-sonnet-5" | "codex/gpt-5.6-luna";

/**
 * Model the Claude conductor runs on. Pinned on purpose: the conductor is a
 * router, not a coder, so it must NOT inherit the Claude catalog default (Opus 5
 * with the 1M window) that code tasks want. Only fills the blank — the composer's
 * native model menu can still move a live conductor to any other Claude model.
 */
const CLAUDE_CONDUCTOR_MODEL = "claude-sonnet-5";
const CLAUDE_CONDUCTOR_PROVIDER: ConductorProvider = "claude/claude-sonnet-5";
const DEFAULT_CONDUCTOR_PROVIDER: ConductorProvider = CLAUDE_CONDUCTOR_PROVIDER;
/**
 * Model the Codex conductor runs on. Same reasoning as the Claude pin above:
 * cheap and fast, not the code-task default.
 */
const CODEX_CONDUCTOR_MODEL = "gpt-5.6-luna";
const CODEX_CONDUCTOR_PROVIDER: ConductorProvider = "codex/gpt-5.6-luna";

/**
 * On Paseo itself (`isSelf`) the conductor is not a router but a full agent that
 * reads, edits and ships the repo — so it earns the frontier model, not the cheap
 * board-manager pin above. Only the blank is filled: an explicit user pick still
 * wins, exactly like the elsewhere defaults.
 */
const CLAUDE_CONDUCTOR_SELF_MODEL = "claude-opus-5";
const CODEX_CONDUCTOR_SELF_MODEL = "gpt-5.6-sol";

// COMPAT(conductorClaudeModel): until v0.2.3 the Claude conductor was created on
// the bare "sonnet" alias. That string is persisted in two places we do not
// migrate — the provider label of every existing conductor record and its
// `config.model` — and old clients still send it over the wire. Both are accepted
// and mapped onto the current Claude conductor. Drop when floor >= v0.2.3 AND
// every stored conductor has been re-locked (see `conductorConfigIsCurrent`).
const LEGACY_CLAUDE_CONDUCTOR_PROVIDER = "claude/sonnet";
const LEGACY_CLAUDE_CONDUCTOR_MODEL = "sonnet";

// COMPAT(conductorModelPin2026Q3): the conductor used to be pinned on Opus 4.8 /
// GPT-5.4 — both real, still-selectable catalog models, so unlike the alias
// above they are NOT force-migrated (a stored value there could be a deliberate
// user pick). Only accepted here so a conductor record still carrying the old
// composite provider label ("claude/claude-opus-4-8", "codex/gpt-5.4") keeps
// resolving instead of throwing "Unsupported conductor provider". Drop once
// every persisted conductor has gone through "Réinitialiser" at least once.
const PREVIOUS_CLAUDE_CONDUCTOR_PROVIDER = "claude/claude-opus-4-8";
const PREVIOUS_CODEX_CONDUCTOR_PROVIDER = "codex/gpt-5.4";

/**
 * Thinking effort a conductor starts on. Without an explicit id the model
 * catalog falls back to the FIRST effort level it declares — "low" — which is the
 * wrong default for an agent whose entire job is to read a project, split it into
 * tasks and route them. An explicit user choice still wins: this only fills the
 * blank.
 */
const CONDUCTOR_CLAUDE_THINKING_OPTION_ID = "medium";
const CONDUCTOR_CODEX_THINKING_OPTION_ID = "medium";
/**
 * On Paseo itself the conductor codes, so it starts on a deeper effort ("high")
 * than the "medium" a board manager needs elsewhere. Fills the blank only.
 */
const CONDUCTOR_CLAUDE_SELF_THINKING_OPTION_ID = "high";
const CONDUCTOR_CODEX_SELF_THINKING_OPTION_ID = "high";

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
  // Bundle project files into a downloadable zip offered in the chat.
  "create_project_archive",
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
    `Identifiant du projet : ${projectId} — passe-le à chaque outil du tableau.`,
    "",
    "AGENT COMPLET (particularité de ce dépôt) : contrairement aux chefs",
    "d'orchestre des autres projets, tu n'es pas limité au tableau. Une demande",
    "d'action (corriger, modifier, publier), tu la RÉALISES toi-même avec les",
    "outils d'édition, de terminal et de lecture — au lieu de créer une carte.",
    "Tu gardes le tableau sous la main (list_tasks, create_task, update_task,",
    "move_task, delete_task) quand c'est l'intention réelle de l'utilisateur.",
    "",
    "ENREGISTRER OUI, PUBLIER NON : après une modification, tu commits et tu",
    "pushes pour ne rien perdre. Tu ne DÉPLOIES JAMAIS de ta propre initiative —",
    "seulement sur « déploie / publie / mets en ligne ». Les commits non déployés",
    "s'affichent dans la fenêtre « À déployer » : c'est voulu. Ne redémarre jamais",
    "le daemon (port 6767) sans accord explicite : cela tuerait les agents en",
    "cours, dont peut-être toi-même.",
    "",
    "Rends compte simplement, en français clair. Pas de gabarit imposé.",
  ].join("\n");
}

/**
 * Consigne du chef d'orchestre « gestionnaire de tableau » (tous les projets
 * sauf Paseo lui-même).
 *
 * TENUE COURTE VOLONTAIREMENT : elle accompagne chaque tour de cette
 * conversation. La version longue répétait chaque règle deux ou trois fois et
 * listait des exemples pour chacune ; elle a été condensée à une ligne par
 * règle, sans en retirer aucune. Si une règle doit revenir, elle revient en une
 * clause, pas en paragraphe.
 */
function conductorBoardManagerSystemPrompt(projectId: string): string {
  return [
    "Tu es le « chef d'orchestre » du tableau de tâches de ce projet.",
    `Identifiant du projet : ${projectId} — passe-le à chaque outil.`,
    "",
    "TU NE TOUCHES JAMAIS AU CODE — UNE TÂCHE, JAMAIS UNE EXÉCUTION.",
    "Ni fichier modifié, ni commande, ni commit,",
    "ni build, ni test, ni déploiement, ni terminal, ni agent lancé pour le faire",
    "à ta place. Les outils correspondants te sont d'ailleurs retirés : l'envie",
    "d'agir sur le code est le signe qu'il faut créer une carte.",
    "",
    "Tes outils : list_tasks, create_task, update_task,",
    "move_task (« notes » ↔ « backlog » UNIQUEMENT), delete_task.",
    "",
    "TOUT MESSAGE NE DEVIENT PAS UNE CARTE. Trie d'abord dans une des quatre",
    "familles, puis applique exactement son comportement. Les exemples comptent",
    "autant que la règle : c'est à eux que tu reconnais la famille.",
    "1) QUESTION ou DEMANDE D'INFORMATION → tu réponds, tu ne crées AUCUNE carte.",
    "   « comment ça marche ? », « où en est la tâche X ? », « combien de cartes",
    "   sont en attente ? », « pourquoi ce comportement ? ». Tu peux lire le",
    "   tableau ou le code pour répondre juste : lire n'est pas agir. Pas de carte",
    "   « pour garder une trace ».",
    "2) DEMANDE D'ACTION → create_task, proposeRun à false (ou absent) : la carte",
    "   apparaît dans « À faire » et s'arrête là. « corrige le graphe pour qu'il",
    "   soit en pleine largeur », « ajoute un bouton d'export », « supprime la",
    "   section des favoris », « le bouton ne répond plus » — un bug signalé est",
    "   une demande de correction. Pas besoin de demander l'autorisation d'ajouter.",
    "3) CAS AMBIGU (« le chargement est lent, non ? ») → tu réponds, puis UNE",
    "   phrase « Souhaitez-vous que j'en fasse une tâche ? ». Écris-la en DERNIER",
    "   et sur sa propre ligne : l'app y accroche un bouton de confirmation. Tu ne",
    "   crées la carte qu'au message suivant, si l'utilisateur confirme.",
    "4) GESTION DU TABLEAU LUI-MÊME → l'outil, pas une carte. « renomme la carte",
    "   X », « déplace la carte Y », « liste les cartes en attente » : appelle",
    "   update_task / move_task / delete_task / list_tasks directement.",
    "Hésitation entre 1 et 2 → traite en 3.",
    "",
    "LA VALIDATION APPARTIENT À L'UTILISATEUR. Cycle : À faire → Validé →",
    "Planifié → En cours → Terminé → Déployé. Tu n'écris QUE dans « notes » et",
    "« backlog ». Jamais « Validé », même demandé, même urgent, même après un",
    "« vas-y » : c'est par ce geste que LUI seul autorise la dépense de quota, et",
    "la suite (planification, lancement, fin, publication) ne t'appartient pas non",
    "plus. Si on te le demande, réponds que la carte est prête dans « À faire » et",
    "qu'il suffit de la glisser — l'outil refusera de toute façon.",
    "",
    "proposeRun=true UNIQUEMENT sur les mots « propose », « proposition » ou",
    "« à valider ». Sinon création directe.",
    "",
    "FORME : tu n'exécutes rien, donc tu ne rends compte de rien. Le gabarit long",
    "en sections numérotées ne s'applique JAMAIS à toi, même si un bloc de",
    "consignes te le suggère : quelques phrases de français simple, sans titres,",
    "sans estimation et sans facturation. Si tu as touché des cartes, termine par",
    "une puce par carte (titre + ce qui lui est arrivé). Et rappelle-toi que tu",
    "n'écris pas de code et ne fais jamais passer une carte en « Validé ».",
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
    normalized === LEGACY_CLAUDE_CONDUCTOR_PROVIDER ||
    normalized === PREVIOUS_CLAUDE_CONDUCTOR_PROVIDER
  ) {
    return CLAUDE_CONDUCTOR_PROVIDER;
  }
  if (
    normalized === "codex" ||
    normalized === CODEX_CONDUCTOR_PROVIDER ||
    normalized === PREVIOUS_CODEX_CONDUCTOR_PROVIDER
  ) {
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
    const codexBase = {
      ...base,
      // Same "fill the blank, an explicit pick still wins" rule as Claude below.
      // On Paseo itself the conductor codes → deeper effort + frontier model.
      thinkingOptionId: resolveConductorEffort(
        base.thinkingOptionId,
        isSelf,
        CONDUCTOR_CODEX_THINKING_OPTION_ID,
        CONDUCTOR_CODEX_SELF_THINKING_OPTION_ID,
      ),
      model: resolveCodexConductorModel(base.model, isSelf),
    };
    // On Paseo itself the conductor is a full agent: no read-only sandbox, let it
    // edit the repo and run commands like any global Codex agent.
    if (isSelf) {
      return { ...codexBase, approvalPolicy: "on-request", sandboxMode: "workspace-write" };
    }
    return {
      ...codexBase,
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
    thinkingOptionId: resolveConductorEffort(
      base.thinkingOptionId,
      isSelf,
      CONDUCTOR_CLAUDE_THINKING_OPTION_ID,
      CONDUCTOR_CLAUDE_SELF_THINKING_OPTION_ID,
    ),
    model: resolveClaudeConductorModel(base.model, isSelf),
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
    // Same "no stored id/model yet" staleness check as the Claude branch below —
    // fills the blank on a conductor that predates these defaults, never
    // overrides an explicit pick already on record.
    if (config.thinkingOptionId == null || config.model == null) {
      return false;
    }
    // On Paseo the leaked board-manager pins (luna / "medium") must be re-locked up
    // to the frontier — mirrors `resolveCodexConductorModel` / `resolveConductorEffort`.
    if (
      isSelf &&
      (config.model === CODEX_CONDUCTOR_MODEL ||
        config.thinkingOptionId === CONDUCTOR_CODEX_THINKING_OPTION_ID)
    ) {
      return false;
    }
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
  // On Paseo the leaked board-manager pins (sonnet-5 / "medium") must be re-locked
  // up to the frontier — mirrors `resolveClaudeConductorModel` / `resolveConductorEffort`.
  if (
    isSelf &&
    (config.model === CLAUDE_CONDUCTOR_MODEL ||
      config.thinkingOptionId === CONDUCTOR_CLAUDE_THINKING_OPTION_ID)
  ) {
    return false;
  }
  const expectedDisallowed = isSelf ? [] : CONDUCTOR_DISALLOWED_TOOLS;
  return sameToolSet(readStoredDisallowedTools(config.extra), expectedDisallowed);
}

/**
 * Model a Claude conductor should carry. An explicit pick from the composer's
 * model menu wins; a blank — or the legacy bare "sonnet" alias, which that menu
 * never offers and so can only come from the old hardcoded default — falls to the
 * pinned conductor model. On Paseo itself (`isSelf`) that pin is the frontier
 * model, since the conductor codes there instead of only routing.
 */
function resolveClaudeConductorModel(
  storedModel: string | null | undefined,
  isSelf: boolean,
): string {
  if (!storedModel || storedModel === LEGACY_CLAUDE_CONDUCTOR_MODEL) {
    return isSelf ? CLAUDE_CONDUCTOR_SELF_MODEL : CLAUDE_CONDUCTOR_MODEL;
  }
  // On Paseo itself the cheap board-manager pin is never a deliberate pick: it can
  // only have leaked in from a conductor created before `isSelf` earned the
  // frontier model. Treat it like the legacy alias above and force it up, so an
  // existing Paseo conductor self-heals on next open instead of staying on Sonnet
  // for the life of the record. Any OTHER stored model is still respected.
  if (isSelf && storedModel === CLAUDE_CONDUCTOR_MODEL) {
    return CLAUDE_CONDUCTOR_SELF_MODEL;
  }
  return storedModel;
}

/**
 * Codex counterpart of {@link resolveClaudeConductorModel}: fill a blank with the
 * board-manager pin (or the frontier model on Paseo itself), and — on Paseo only —
 * force the leaked board-manager pin up to the frontier so an existing conductor
 * stops opening on the cheap model. Any other stored model is preserved.
 */
function resolveCodexConductorModel(
  storedModel: string | null | undefined,
  isSelf: boolean,
): string {
  if (!storedModel) {
    return isSelf ? CODEX_CONDUCTOR_SELF_MODEL : CODEX_CONDUCTOR_MODEL;
  }
  if (isSelf && storedModel === CODEX_CONDUCTOR_MODEL) {
    return CODEX_CONDUCTOR_SELF_MODEL;
  }
  return storedModel;
}

/**
 * Thinking effort a conductor should carry. Same shape as the model resolvers: a
 * blank falls to the default for the context, and on Paseo itself the leaked
 * board-manager "medium" is forced up to "high" (the two leaked together when the
 * record predated `isSelf`). Any other explicit level is preserved.
 */
function resolveConductorEffort(
  storedEffort: string | null | undefined,
  isSelf: boolean,
  boardDefault: string,
  selfDefault: string,
): string {
  if (storedEffort == null) {
    return isSelf ? selfDefault : boardDefault;
  }
  if (isSelf && storedEffort === boardDefault) {
    return selfDefault;
  }
  return storedEffort;
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
