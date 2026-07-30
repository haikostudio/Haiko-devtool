/**
 * Server-side response-format directive.
 *
 * The user's fixed answer structure used to live only in a per-session memory
 * note, so only agents that happened to carry that memory produced it — every
 * other path (Codex admin tasks, schedules, loops, MCP sends, other sessions)
 * answered free-form. This module turns that guidance into a prompt envelope
 * injected at the AgentManager choke point, exactly like the Cerveau recall
 * block, so EVERY non-internal agent gets it for free.
 *
 * There is not ONE structure but several, because a card's answer means a
 * different thing depending on where the card sits on the board (see
 * docs/response-templates.md, the single reference for the three card
 * templates):
 *  - "analysis"    — "Validé"/"Planifié": the work has NOT run yet, so the answer
 *                    is a plan + an estimate, never a report.
 *  - "progress"    — "En cours"/"Terminée": what was done, and what could come
 *                    next (each proposal on its own line, so the app can hang a
 *                    "+" button on it).
 *  - "publication" — a running deployment, or "Déployé": what went online, how
 *                    it went, and how it was verified (one card).
 *  - "batchPublication" — the single grouped-deployment agent that publishes
 *                    every queued card of "À déployer" in one batch: the list of
 *                    cards it shipped, what actually went live, the verdict, and
 *                    the final state. Routed by the agent's deployment role
 *                    label, not by a card's column.
 *  - "conductor"   — the board's chef d'orchestre: it never executes anything,
 *                    so it never reports — a short answer, or a bullet list of
 *                    the cards it touched.
 *  - "default"     — everything that is not a card (plain chat, schedules, MCP):
 *                    the historical five-section report.
 *
 * The template is chosen by the daemon, never by the agent: the hook installed
 * on the AgentManager resolves the card's current column at dispatch time.
 *
 * The directive is wrapped in a <paseo-format>…</paseo-format> envelope so the
 * daemon can strip it from the displayed user message (like the brain envelope)
 * — the agent reads it, the user never sees the raw XML.
 */

/** Which fixed answer structure a prompt must carry. */
export type ResponseFormatTemplate =
  | "default"
  | "analysis"
  | "progress"
  | "publication"
  | "batchPublication"
  | "conductor";

/**
 * Resolves the template for an agent at dispatch time. Installed on the
 * AgentManager at bootstrap by the task board side, which is the only place
 * that knows whether an agent belongs to a card and in which column it sits.
 * Returning null (or throwing) falls back to {@link DEFAULT_RESPONSE_TEMPLATE}.
 */
export type ResponseFormatTemplateHook = (input: {
  agentId: string;
}) => Promise<ResponseFormatTemplate | null>;

export const DEFAULT_RESPONSE_TEMPLATE: ResponseFormatTemplate = "default";

/**
 * Opening line shared by every template: who answers, and for whom.
 *
 * TENU COURT VOLONTAIREMENT. Ce bloc part en tête de CHAQUE message envoyé à
 * CHAQUE agent : chaque phrase superflue ici est payée autant de fois qu'il y a
 * de messages. La version longue coûtait ~350 jetons par prompt.
 */
const COMMON_HEADER = [
  "Lecteur non technique : phrases simples, images concrètes, sans jargon ni chemins de fichiers.",
  "En-tête : une ligne = modèle (Opus = code, Codex = admin), niveau, temps estimé, coût (130 CHF/h).",
];

/**
 * Budget de longueur, commun à tous les gabarits. La consigne de forme obtenait
 * jusqu'ici des réponses complètes MAIS bavardes (rappel du contexte, résumé
 * final, redites d'une section à l'autre) : c'est le poste de dépense n°1 côté
 * production, celui qui épuise le quota. On plafonne explicitement.
 */
const BREVITY = [
  "SOIS BREF : 1 à 3 phrases par section, ou 3 à 5 puces courtes.",
  "Pas de préambule, pas de conclusion générale, pas de redite d'une section à l'autre,",
  "pas de reformulation de la demande, pas d'extrait de code sauf demande explicite.",
];

/** Closing lines shared by every template. */
const COMMON_FOOTER = [
  "Callouts (> [!TIP], > [!NOTE], > [!WARNING]) seulement s'ils aident vraiment.",
  "Les icônes des titres sont ajoutées automatiquement par l'app — n'en mets pas toi-même.",
];

/** Historical five-section report — everything that is not a board card. */
const DEFAULT_BODY = [
  "Réponds exactement avec cette structure.",
  ...COMMON_HEADER,
  ...BREVITY,
  "",
  "Cinq sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui est fait",
  "## 2. Ce qui change",
  "## 3. Impact",
  "## 4. Évolutions possibles",
  "## 5. Activation & facturation",
  "",
  "Section 5 : finis par temps réel/estimé, taux (130 CHF/h) et coût. Si le travail concerne",
  "un projet client identifiable (pas l'outillage interne), propose ensuite une ligne de facture",
  "brouillon via la compétence compta — jamais de facture créée ou modifiée sans accord explicite.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * "Validé"/"Planifié": nothing has been implemented yet. Anything phrased as a
 * report ("Ce qui est fait") would be a lie, so those sections are banned
 * outright rather than merely discouraged.
 */
const ANALYSIS_BODY = [
  "Carte en analyse (colonne « Validé ») : le travail n'est PAS encore exécuté — jamais de compte rendu.",
  ...COMMON_HEADER,
  ...BREVITY,
  "",
  "Quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Objectif",
  "## 2. Approche retenue",
  "## 3. Fichiers & points de vigilance",
  "## 4. Estimation",
  "",
  "3 : un TABLEAU | Élément | Détail |, une ligne par fichier touché et par risque.",
  "4 : temps estimé, heures facturables, taux 130 CHF/h, total, part de quota. Un éventuel",
  "bloc ```json d'estimation demandé par le prompt termine la réponse.",
  "Aucune autre section (ni « Ce qui est fait », ni « Évolutions possibles », ni « Activation & facturation »).",
  ...COMMON_FOOTER,
].join("\n");

/**
 * "En cours"/"Terminée": the work report. The evolutions section is the one the
 * app decorates — every proposal gets a "+" button that drops the line into the
 * composer — hence the "one self-contained line per proposal" rule.
 */
const PROGRESS_BODY = [
  "Carte en cours de travail : ta réponse est un point d'AVANCEMENT.",
  ...COMMON_HEADER,
  ...BREVITY,
  "",
  "Quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui est fait",
  "## 2. Ce qui change",
  "## 3. Impact",
  "## 4. Évolutions possibles",
  "",
  "Section 4 : chaque proposition sur UNE seule ligne de liste, autonome et compréhensible seule",
  "(l'app y pose un bouton « + » pour la réutiliser telle quelle). Ni sous-liste ni paragraphe.",
  "Aucune autre section : ni facturation, ni analyse, ni estimation.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * A running deployment, or "Déployé": the publication log. This turn is also the
 * one that CHECKS the work — finishing a card is a pure move now, so the
 * verification section is a real report of what was exercised and fixed, not a
 * formality. Billing and evolutions belong to the other two moments of the card's
 * life, so they are excluded here.
 */
const PUBLICATION_BODY = [
  "Carte en publication : ta réponse est un compte rendu de MISE EN LIGNE.",
  ...COMMON_HEADER,
  ...BREVITY,
  "",
  "Quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui a été publié",
  "## 2. Déroulé de la publication",
  "## 3. Vérification",
  "## 4. Suites éventuelles",
  "",
  "2 : les étapes dans l'ordre et leur résultat (réussi / échoué, et pourquoi).",
  "3 : ce que tu as réellement contrôlé — demande initiale satisfaite, tests/typecheck/lint passés,",
  "corrections faites au passage, version réellement en ligne.",
  "4 : redémarrage du moteur ou non, points à surveiller. « Rien à signaler » si c'est le cas.",
  "Aucune autre section : ni analyse, ni estimation, ni facturation, ni évolutions.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * The single grouped-deployment agent. It gathers EVERY card queued in "À
 * déployer" and publishes them in one batch, so its answer is a batch
 * publication log — the list of cards it shipped, what actually went live, the
 * verdict (the live version matching the last saved one), and the final state.
 * It is routed by the agent's deployment role label, not by a card column, since
 * one run spans several cards. Billing, estimates, analysis and evolutions
 * belong elsewhere, so they are excluded here too.
 */
const BATCH_PUBLICATION_BODY = [
  "Tu es l'agent de PUBLICATION GROUPÉE : tu mets en ligne EN UN SEUL LOT toutes les tâches en file « À déployer ».",
  "Compte rendu du LOT, pas d'une seule carte.",
  ...COMMON_HEADER,
  ...BREVITY,
  "",
  "Quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Tâches publiées",
  "## 2. Ce qui est en ligne",
  "## 3. Résultat de la publication",
  "## 4. État final",
  "",
  "1 : une carte par ligne, avec en une phrase ce qu'elle apporte.",
  "2 : ce que le public voit réellement maintenant, pas l'intention.",
  "3 : réussi ou échoué, avec la vérification que la version en ligne est bien la dernière enregistrée",
  "(et, en cas d'échec, la raison précise).",
  "4 : cartes prêtes à archiver, redémarrage du moteur ou non, points à surveiller.",
  "Aucune autre section : ni analyse, ni chiffrage, ni facturation, ni évolutions.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * The board's "chef d'orchestre". It never executes anything, so it has nothing
 * to report: dressing its answers in the work-report sections turned a plain
 * "combien de cartes en attente ?" into a fake chantier with an invoice line at
 * the end. Its shape follows the message it answers — a couple of sentences for
 * a question, a bullet list of the cards it touched otherwise — which is the
 * same rule its system prompt states (see conductor-agent.ts).
 */
const CONDUCTOR_BODY = [
  "Tu es le chef d'orchestre du tableau : tu n'exécutes aucun travail, donc tu n'en rends jamais compte.",
  "Aucun gabarit à sections, aucune estimation de temps/quota/coût, aucune facturation, aucun en-tête de modèle.",
  "Réponds en 1 à 3 phrases de français simple. Pour un cas ambigu, propose d'en faire une tâche.",
  "Si tu as touché des cartes : une puce par carte (titre + ce qui lui est arrivé), rien de plus.",
  "Lecteur non technique : phrases simples, sans jargon ni chemins de fichiers.",
  ...COMMON_FOOTER,
].join("\n");

const RESPONSE_FORMAT_BODIES: Record<ResponseFormatTemplate, string> = {
  default: DEFAULT_BODY,
  analysis: ANALYSIS_BODY,
  progress: PROGRESS_BODY,
  publication: PUBLICATION_BODY,
  batchPublication: BATCH_PUBLICATION_BODY,
  conductor: CONDUCTOR_BODY,
};

/** The instruction body for a template. Exported for tests and docs checks. */
export function responseFormatBody(template: ResponseFormatTemplate): string {
  return RESPONSE_FORMAT_BODIES[template];
}

const OPEN_TAG = "<paseo-format>";
const CLOSE_TAG = "</paseo-format>";

/**
 * Leading directive envelope followed by a blank line, then whatever prompt
 * text was going to be sent (which may itself be a <contexte_memoire> block).
 * Matched non-greedily and anchored to the start so it only strips our own
 * prefix, leaving the real prompt intact.
 */
const RESPONSE_FORMAT_PATTERN = new RegExp(`^${OPEN_TAG}\\n[\\s\\S]*?\\n${CLOSE_TAG}\\n\\n`);

/** True when the text already carries the directive (requeues, replays). */
export function hasResponseFormatDirective(text: string): boolean {
  return RESPONSE_FORMAT_PATTERN.test(text);
}

/** Prepend the directive envelope to a prompt, unless it is already present. */
export function injectResponseFormat(
  text: string,
  template: ResponseFormatTemplate = DEFAULT_RESPONSE_TEMPLATE,
): string {
  if (hasResponseFormatDirective(text)) {
    return text;
  }
  return `${OPEN_TAG}\n${RESPONSE_FORMAT_BODIES[template]}\n${CLOSE_TAG}\n\n${text}`;
}

/** Remove the leading directive envelope for display. No-op when absent. */
export function stripResponseFormat(text: string): string {
  return text.replace(RESPONSE_FORMAT_PATTERN, "");
}
