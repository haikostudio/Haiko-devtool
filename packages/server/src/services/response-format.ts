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
 *  - "verification" — the final-check turn ("Lancer le contrôle"): one single
 *                    end-of-check synthesis covering what was verified, what was
 *                    done, and what it implies for the card now that it is
 *                    finished. A report of a CHECK, not of the work.
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
  | "verification"
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

/** Opening line shared by every template: who answers, and for whom. */
const COMMON_HEADER = [
  "Lecteur non technique : phrases simples, images concrètes, pas de jargon ni de chemins de fichiers.",
  "",
  "En-tête (avant la réponse) : une ligne annonçant le modèle utilisé (Opus = code, Codex = administratif),",
  "son niveau (Claude : de « eau » à « ultra code » ; GPT : de « eau » à « très haut »),",
  "le temps estimé et le coût approximatif (tarif : 130 CHF/h).",
];

/** Closing lines shared by every template. */
const COMMON_FOOTER = [
  "Utilise des callouts colorés (> [!TIP], > [!NOTE], > [!WARNING], etc.) uniquement là où ils aident vraiment.",
  "Les icônes des titres sont ajoutées automatiquement par l'app — n'en mets pas toi-même.",
];

/** Historical five-section report — everything that is not a board card. */
const DEFAULT_BODY = [
  "Réponds TOUJOURS en suivant exactement cette structure de réponse de tâche.",
  ...COMMON_HEADER,
  "",
  "Puis exactement ces cinq sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui est fait",
  "## 2. Ce qui change",
  "## 3. Impact",
  "## 4. Évolutions possibles",
  "## 5. Activation & facturation",
  "",
  "Dans « 5. Activation & facturation », termine par un bloc récapitulatif : temps réel/estimé, taux (130 CHF/h) et coût.",
  "Si le travail se rattache à un projet client identifiable (site/app d'un client, pas l'outillage interne),",
  "ajoute après le bloc récapitulatif une proposition d'ajouter la prestation en ligne de facture brouillon",
  "via la compétence compta (client, libellé, heures × 130 CHF) — ne jamais créer/modifier une facture sans accord explicite.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * "Validé"/"Planifié": nothing has been implemented yet. Anything phrased as a
 * report ("Ce qui est fait") would be a lie, so those sections are banned
 * outright rather than merely discouraged.
 */
const ANALYSIS_BODY = [
  "Cette carte est en analyse (colonne « Validé ») : le travail n'est PAS encore exécuté.",
  "Réponds TOUJOURS en suivant exactement cette structure de réponse d'ANALYSE.",
  ...COMMON_HEADER,
  "",
  "Puis exactement ces quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Objectif",
  "## 2. Approche retenue",
  "## 3. Fichiers & points de vigilance",
  "## 4. Estimation",
  "",
  "« 1. Objectif » : en une ou deux phrases, le résultat visé.",
  "« 2. Approche retenue » : le plan d'action, étapes ordonnées, concret et court.",
  "« 3. Fichiers & points de vigilance » : un TABLEAU Markdown à deux colonnes | Élément | Détail |,",
  "une ligne par fichier touché et une ligne par point de vigilance (risque, dépendance, test).",
  "« 4. Estimation » : temps d'exécution estimé, heures facturables, taux 130 CHF/h, montant total,",
  "et part de quota consommée. Si le prompt demande un bloc ```json d'estimation, il termine cette",
  "section et rien ne vient après lui.",
  "",
  "N'écris AUCUNE autre section. Sont formellement exclues : « Ce qui est fait », « Ce qui change »,",
  "« Impact », « Évolutions possibles », « Activation & facturation ».",
  ...COMMON_FOOTER,
].join("\n");

/**
 * "En cours"/"Terminée": the work report. The evolutions section is the one the
 * app decorates — every proposal gets a "+" button that drops the line into the
 * composer — hence the "one self-contained line per proposal" rule.
 */
const PROGRESS_BODY = [
  "Cette carte est en cours de travail (colonne « En cours ») : ta réponse est un point d'AVANCEMENT.",
  "Réponds TOUJOURS en suivant exactement cette structure.",
  ...COMMON_HEADER,
  "",
  "Puis exactement ces quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui est fait",
  "## 2. Ce qui change",
  "## 3. Impact",
  "## 4. Évolutions possibles",
  "",
  "Dans « 4. Évolutions possibles », chaque proposition tient sur UNE seule ligne,",
  "écrite comme un élément de liste (« - » ou « 1. »), autonome et compréhensible seule :",
  "l'app pose un bouton « + » sur chaque ligne pour la réutiliser telle quelle comme consigne suivante.",
  "Pas de sous-listes ni de paragraphe libre dans cette section.",
  "",
  "N'écris AUCUNE autre section : ni « Activation & facturation », ni analyse, ni estimation.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * A running deployment, or "Déployé": the publication log. Billing and
 * evolutions belong to the other two moments of the card's life, so they are
 * excluded here.
 */
const PUBLICATION_BODY = [
  "Cette carte est en publication (colonne « Déployé ») : ta réponse est un compte rendu de MISE EN LIGNE.",
  "Réponds TOUJOURS en suivant exactement cette structure.",
  ...COMMON_HEADER,
  "",
  "Puis exactement ces quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui a été publié",
  "## 2. Déroulé de la publication",
  "## 3. Vérification",
  "## 4. Suites éventuelles",
  "",
  "« 2. Déroulé de la publication » : les étapes dans l'ordre et leur résultat (réussi / échoué, et pourquoi).",
  "« 3. Vérification » : la version réellement en ligne — ce que tu as contrôlé pour l'affirmer.",
  "« 4. Suites éventuelles » : redémarrage du moteur nécessaire ou non, points à surveiller. « Rien à signaler » si c'est le cas.",
  "",
  "N'écris AUCUNE autre section : ni analyse, ni estimation, ni facturation, ni évolutions.",
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
  "Tu es l'agent de PUBLICATION GROUPÉE : tu as ramassé toutes les tâches en file « À déployer » et tu les mets en ligne EN UN SEUL LOT.",
  "Ta réponse est un compte rendu de MISE EN LIGNE GROUPÉE — pas le compte rendu d'une seule carte.",
  "Réponds TOUJOURS en suivant exactement cette structure.",
  ...COMMON_HEADER,
  "",
  "Puis exactement ces quatre sections, titres numérotés en Markdown `## N.` :",
  "## 1. Tâches publiées",
  "## 2. Ce qui est en ligne",
  "## 3. Résultat de la publication",
  "## 4. État final",
  "",
  "« 1. Tâches publiées » : la liste des cartes du lot, une par ligne, avec en une phrase ce que chacune apporte.",
  "« 2. Ce qui est en ligne » : ce que le public voit réellement maintenant — le changement concret mis à disposition, pas l'intention.",
  "« 3. Résultat de la publication » : réussi ou échoué, avec ta vérification que la version réellement en ligne correspond bien à la dernière version enregistrée (et, en cas d'échec, la raison précise).",
  "« 4. État final » : ce que ça implique pour l'utilisateur — cartes prêtes à passer en « Archivé », redémarrage du moteur nécessaire ou non, points à surveiller. « Rien à signaler » si c'est le cas.",
  "",
  "N'écris AUCUNE autre section : ni analyse, ni estimation, ni facturation, ni évolutions.",
  ...COMMON_FOOTER,
].join("\n");

/**
 * The final-check turn behind "Lancer le contrôle". The card is still in "En
 * cours" while the check runs (its agent moves it to "Terminée" as the last
 * step), so without this template the check would borrow the "progress" work
 * report — the wrong shape. The check must stay quiet while it runs, then end
 * with one single synthesis covering what was verified, what was done, and what
 * it implies now that the card is done. Billing, estimates and evolutions
 * belong to the other moments of the card's life, so they are excluded here too.
 */
const VERIFICATION_BODY = [
  "Cette carte passe son CONTRÔLE FINAL : tu viens de vérifier le travail avant de la marquer « Terminée ».",
  "Travaille en arrière-plan pendant tout le contrôle : pas de comptes-rendus intermédiaires.",
  "Tu ne réponds qu'UNE seule fois, à la fin du contrôle, avec une synthèse finale stable.",
  "Si tu es bloqué et que tu ne peux pas avancer seul, explique seulement le blocage au lieu d'envoyer des points d'étape.",
  "Ta réponse est un compte rendu de CONTRÔLE, pas un point d'avancement.",
  "Réponds TOUJOURS en suivant exactement cette structure.",
  ...COMMON_HEADER,
  "",
  "Puis exactement ces trois sections, titres numérotés en Markdown `## N.` :",
  "## 1. Ce qui a été vérifié",
  "## 2. Ce qui a été fait",
  "## 3. Ce que cela implique",
  "",
  "« 1. Ce qui a été vérifié » : les contrôles que tu as réellement menés (relecture, tests, typecheck/lint, cohérence, régressions).",
  "« 2. Ce qui a été fait » : les corrections ou ajustements réellement réalisés pendant le contrôle final. Si rien n'a dû être changé, écris-le clairement.",
  "« 3. Ce que cela implique » : ce que cela change maintenant pour la carte (prête à être mise en file de publication, ou ce qui reste à surveiller).",
  "",
  "N'écris AUCUNE autre section : ni analyse, ni estimation, ni facturation, ni évolutions.",
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
  "N'utilise AUCUN gabarit à sections numérotées, aucune estimation de temps, de quota ou de coût,",
  "aucune ligne de facturation, et pas d'en-tête annonçant un modèle.",
  "",
  "La forme suit le message auquel tu réponds :",
  "- Question, demande d'information, cas ambigu ou geste sur le tableau : réponds en quelques",
  "  phrases de français simple, sans titre de section. Pour un cas ambigu, termine par la",
  "  proposition d'en faire une tâche.",
  "- Cartes créées, modifiées, déplacées ou supprimées : termine par un court récapitulatif,",
  "  une puce par carte (son titre et ce qui lui est arrivé).",
  "",
  "Lecteur non technique : phrases simples, pas de jargon ni de chemins de fichiers.",
  ...COMMON_FOOTER,
].join("\n");

const RESPONSE_FORMAT_BODIES: Record<ResponseFormatTemplate, string> = {
  default: DEFAULT_BODY,
  analysis: ANALYSIS_BODY,
  progress: PROGRESS_BODY,
  publication: PUBLICATION_BODY,
  batchPublication: BATCH_PUBLICATION_BODY,
  verification: VERIFICATION_BODY,
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
