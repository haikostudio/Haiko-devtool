import { z } from "zod";
import type { Logger } from "pino";
import type { AgentManager } from "../../server/agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../../server/agent/create-agent/create.js";
import { getStructuredAgentResponse } from "../../server/agent/agent-response-loop.js";
import type { AgentTimelineItem } from "../../server/agent/agent-sdk-types.js";
import type { BrainMemoryClient, BrainSouvenir } from "./client.js";
import type { ProjectBriefStore } from "./project-brief.js";
import { hasRecallSubstance } from "./recall-gate.js";
import type { RecentFactsStore } from "./recent-facts.js";

/**
 * Intelligence layer between the Cerveau and the conversation, two roles:
 *
 * - The librarian (`filterRecall`): re-reads the memories a fuzzy Cerveau
 *   search surfaced and keeps only those that genuinely help the current
 *   request. Runs ON the prompt path — bounded by a timeout, and any failure
 *   falls back to the unfiltered recall (an outage must never block a prompt).
 * - The scribe (`distillExchange`): after a completed turn, extracts the few
 *   durable facts worth remembering (decisions, preferences, gotchas) and
 *   notes THOSE to the Cerveau instead of the raw exchange, and rewrites the
 *   project fiche when the exchange reshaped the big picture. Runs off-path,
 *   fire-and-forget.
 *
 * Both roles run as short-lived internal Haiku agents, mirroring the
 * message-triage pattern (same createAgent/runAgent/archive lifecycle).
 */

const DEFAULT_CURATOR_PROVIDER_MODEL = "claude/haiku";

// On-path guard: past this, give up on the librarian and inject unfiltered.
// The underlying internal agent finishes (and archives) on its own.
const FILTER_TIMEOUT_MS = 20_000;

// A trivial exchange ("dis OK" → "OK") isn't worth a distillation call. A
// low-substance user message still distills when the assistant produced a
// substantial answer ("Oui" → the agent shipped a feature).
const MIN_ASSISTANT_TEXT_FOR_TRIVIAL_PROMPT = 300;

const MAX_PROMPT_USER_CHARS = 4_000;
const MAX_PROMPT_ASSISTANT_CHARS = 6_000;
const MAX_PROMPT_MEMORY_CHARS = 500;
const MAX_PROMPT_ACTIONS_CHARS = 1_200;

// Past this age, the fiche is nudged for a refresh even on an otherwise-modest
// exchange, so a long-running project's snapshot doesn't silently drift stale.
const FICHE_STALE_MS = 24 * 60 * 60 * 1000; // 24 h

const RecallFilterSchema = z.object({
  garder: z.array(z.number().int().min(0)).default([]),
});

const ExchangeDistillationSchema = z.object({
  souvenirs: z.array(z.string().min(1)).max(3).default([]),
  fiche: z.string().nullable().default(null),
});

/** Render the fiche as a synthetic memory so it flows through the existing blob/pill machinery. */
export function briefToSouvenir(projet: string, brief: string): BrainSouvenir {
  return { texte: `📁 Fiche projet — ${projet}\n${brief}` };
}

/** Assemble the scribe's distillation prompt (extracted to keep the method flat). */
function buildScribePrompt(input: {
  projet: string | undefined;
  brief: string | null;
  ficheStale: boolean;
  userText: string;
  assistantText: string;
  actions: string | null;
}): string {
  return [
    "Tu es le greffier de la mémoire long-terme (« Cerveau ») d'un assistant de développement. Tu relis un échange terminé et tu décides ce qui mérite d'être retenu durablement.",
    "",
    `Projet : « ${input.projet ?? "inconnu"} »`,
    "Fiche projet actuelle :",
    '"""',
    input.brief ?? "(aucune fiche pour l'instant)",
    '"""',
    ...(input.ficheStale
      ? [
          "⚠️ Cette fiche n'a pas été retouchée depuis plus de 24 h. Relis-la avec un œil critique : si un chantier y est marqué « en cours » alors que l'échange montre qu'il est terminé/livré, ou si elle ne reflète plus l'état réel, renvoie une fiche à jour.",
        ]
      : []),
    "",
    "Échange :",
    "Utilisateur :",
    '"""',
    input.userText.slice(0, MAX_PROMPT_USER_CHARS),
    '"""',
    "Assistant (fin de réponse) :",
    '"""',
    input.assistantText.slice(0, MAX_PROMPT_ASSISTANT_CHARS) || "(pas de réponse)",
    '"""',
    ...(input.actions
      ? [
          "Actions concrètes réalisées pendant l'échange (commits, déploiements) :",
          '"""',
          input.actions.slice(0, MAX_PROMPT_ACTIONS_CHARS),
          '"""',
          "Ces actions prouvent qu'un travail a été LIVRÉ : un chantier « en cours » qui vient d'être committé/déployé passe à « terminé » dans la fiche, et un livrable notable mérite souvent un souvenir.",
        ]
      : []),
    "",
    "Réponds avec :",
    "1. \"souvenirs\" : 0 à 3 faits durables à retenir dans plusieurs mois — décision prise, préférence exprimée par l'utilisateur, contrainte ou gotcha découvert, piste écartée (et pourquoi), ou travail marquant livré (commit/déploiement). Chaque fait : une phrase autonome et précise qui nomme le projet ou le composant concerné. La PLUPART des échanges n'en méritent AUCUN : confirmations, bavardage, questions ponctuelles, détails d'implémentation visibles dans le code → tableau vide.",
    "2. \"fiche\" : si l'échange change la vue d'ensemble du projet (nouveau chantier, chantier terminé ou livré, décision structurante, préférence durable), renvoie la fiche COMPLÈTE mise à jour ; sinon null.",
    "   La fiche est un markdown court (≤ 3000 caractères) avec ces sections : « Quoi » (ce qu'est le projet), « Points clés » (structure, stack, particularités), « Chantiers en cours », « Décisions & préférences ». Fusionne et élague : elle doit rester une synthèse actuelle, pas un journal. S'il n'y a pas encore de fiche et que l'échange apprend quelque chose de structurant, crée-la.",
  ].join("\n");
}

export interface BrainCuratorOptions {
  agentManager: Pick<AgentManager, "runAgent" | "archiveAgent">;
  createAgent: BoundCreateAgentCommand;
  brain: Pick<BrainMemoryClient, "note">;
  briefStore: ProjectBriefStore;
  recentFacts?: RecentFactsStore | null;
  providerModel?: string;
  logger: Logger;
}

export class BrainCurator {
  private readonly agentManager: Pick<AgentManager, "runAgent" | "archiveAgent">;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly brain: Pick<BrainMemoryClient, "note">;
  private readonly briefStore: ProjectBriefStore;
  private readonly recentFacts: RecentFactsStore | null;
  private readonly providerModel: string;
  private readonly logger: Logger;

  constructor(options: BrainCuratorOptions) {
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.brain = options.brain;
    this.briefStore = options.briefStore;
    this.recentFacts = options.recentFacts ?? null;
    this.providerModel = options.providerModel ?? DEFAULT_CURATOR_PROVIDER_MODEL;
    this.logger = options.logger.child({ module: "brain-curator" });
  }

  async loadBrief(projet: string): Promise<string | null> {
    return await this.briefStore.load(projet);
  }

  /**
   * Librarian: keep only the candidate memories that genuinely help the
   * request. Returns null when the filter is unavailable (error/timeout) —
   * the caller decides the fallback (inject unfiltered).
   */
  async filterRecall(input: {
    prompt: string;
    memories: BrainSouvenir[];
    brief: string | null;
    projet: string | undefined;
    cwd: string;
  }): Promise<BrainSouvenir[] | null> {
    if (input.memories.length === 0) {
      return [];
    }
    const numbered = input.memories
      .map((memory, index) => `${index}. ${(memory.texte ?? "").slice(0, MAX_PROMPT_MEMORY_CHARS)}`)
      .join("\n");
    const prompt = [
      "Tu es le bibliothécaire de la mémoire long-terme (« Cerveau ») d'un assistant de développement.",
      "Une recherche approximative a remonté des souvenirs candidats pour la demande ci-dessous. Ta mission : ne garder QUE ceux qui aident réellement à traiter CETTE demande.",
      "",
      `Projet courant : « ${input.projet ?? "inconnu"} »`,
      ...(input.brief
        ? [
            "Fiche projet (déjà connue de l'assistant, ne sert qu'à juger la pertinence) :",
            '"""',
            input.brief,
            '"""',
          ]
        : []),
      "",
      "Demande de l'utilisateur :",
      '"""',
      input.prompt.slice(0, MAX_PROMPT_USER_CHARS),
      '"""',
      "",
      "Souvenirs candidats :",
      numbered,
      "",
      "Règles :",
      "- Garde un souvenir seulement s'il apporte un contexte utile et spécifique à la demande : même sujet, même composant, décision ou contrainte qui s'applique directement.",
      "- Jette tout ce qui est hors sujet, anecdotique, conversationnel, ou qui concerne un autre projet — même si des mots se ressemblent.",
      "- Une procédure (préfixe 📋) ne se garde que si la demande implique de la dérouler.",
      "- Un souvenir ⛔ (piste écartée) ne se garde que si la demande risque de re-tenter cette piste.",
      "- Dans le doute, jette. Une liste vide est une bonne réponse.",
      "",
      'Réponds avec les indices des souvenirs à garder (tableau "garder").',
    ].join("\n");

    const run = this.runInternalAgent({
      title: "Bibliothécaire mémoire",
      cwd: input.cwd,
      prompt,
      schema: RecallFilterSchema,
      schemaName: "RecallFilter",
    });
    const result = await Promise.race([run, timeoutNull(FILTER_TIMEOUT_MS)]);
    if (!result) {
      return null;
    }
    const keep = [...new Set(result.garder)]
      .filter((index) => index >= 0 && index < input.memories.length)
      .sort((a, b) => a - b);
    return keep.map((index) => input.memories[index] as BrainSouvenir);
  }

  /**
   * Scribe: distill a completed exchange into durable facts (noted to the
   * Cerveau) and refresh the project fiche when the picture changed. Replaces
   * the old raw `Utilisateur/Assistant` note — trivia never reaches the brain.
   */
  async distillExchange(input: {
    userText: string;
    assistantText: string;
    projet: string | undefined;
    cwd: string;
    discussionId: string;
    /** Compact bullet summary of durable actions taken this turn (commits, deploys). */
    actions?: string | null;
  }): Promise<void> {
    const userText = input.userText.trim();
    const assistantText = input.assistantText.trim();
    const actions = input.actions?.trim() || null;
    if (!userText) {
      return;
    }
    // A turn that shipped something (commit/deploy) is always worth distilling
    // even when the words were thin ("voilà, en ligne") — the actions carry the
    // durable signal.
    if (
      !hasRecallSubstance(userText) &&
      assistantText.length < MIN_ASSISTANT_TEXT_FOR_TRIVIAL_PROMPT &&
      !actions
    ) {
      return;
    }
    const brief = input.projet ? await this.briefStore.load(input.projet) : null;
    const ageMs = input.projet ? await this.briefStore.ageMs(input.projet) : null;
    const prompt = buildScribePrompt({
      projet: input.projet,
      brief,
      ficheStale: ageMs !== null && ageMs > FICHE_STALE_MS,
      userText,
      assistantText,
      actions,
    });

    const result = await this.runInternalAgent({
      title: "Greffier mémoire",
      cwd: input.cwd,
      prompt,
      schema: ExchangeDistillationSchema,
      schemaName: "ExchangeDistillation",
    });
    if (!result) {
      return;
    }
    for (const souvenir of result.souvenirs) {
      await this.brain.note(souvenir, {
        source: "paseo-daemon",
        projet: input.projet,
        discussionId: input.discussionId,
      });
    }
    // Write-through cache: the notes above land `pending_synthesis` on the
    // Cerveau (not yet searchable), so mirror them locally to make them
    // recallable on the very next prompt.
    if (this.recentFacts && input.projet && result.souvenirs.length > 0) {
      await this.recentFacts.add(input.projet, result.souvenirs);
    }
    if (result.fiche?.trim() && input.projet) {
      await this.briefStore.save(input.projet, result.fiche);
    }
  }

  private async runInternalAgent<T>(input: {
    title: string;
    cwd: string;
    prompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<T | null> {
    let agentId: string | null = null;
    try {
      const created = await this.createAgent({
        kind: "mcp",
        provider: this.providerModel,
        cwd: input.cwd,
        title: input.title,
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
      return await getStructuredAgentResponse({
        caller: async (prompt) => {
          if (!agentId) {
            throw new Error("Curator agent missing");
          }
          const run = await this.agentManager.runAgent(agentId, prompt);
          return resolveFinalText(run.timeline, run.finalText);
        },
        prompt: input.prompt,
        schema: input.schema,
        maxRetries: 1,
        schemaName: input.schemaName,
      });
    } catch (error) {
      this.logger.debug({ err: error, title: input.title }, "Curator agent failed");
      return null;
    } finally {
      if (agentId) {
        try {
          await this.agentManager.archiveAgent(agentId);
        } catch {
          // Ignore cleanup errors for internal curator agents.
        }
      }
    }
  }
}

function timeoutNull(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
}

// Same fallback as message-triage: some providers return an empty finalText
// while the last assistant_message in the timeline holds the answer.
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
