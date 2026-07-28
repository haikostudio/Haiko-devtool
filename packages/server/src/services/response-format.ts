/**
 * Server-side response-format directive.
 *
 * The user's fixed answer structure (five numbered sections + billing block)
 * used to live only in a per-session memory note, so only agents that happened
 * to carry that memory produced it — every other path (Codex admin tasks,
 * schedules, loops, MCP sends, other sessions) answered free-form. This module
 * turns that guidance into a prompt envelope injected at the AgentManager choke
 * point, exactly like the Cerveau recall block, so EVERY non-internal agent gets
 * it for free.
 *
 * The directive is wrapped in a <paseo-format>…</paseo-format> envelope so the
 * daemon can strip it from the displayed user message (like the brain envelope)
 * — the agent reads it, the user never sees the raw XML.
 */

/** The instruction body. French, because the user's answers are French. */
const RESPONSE_FORMAT_BODY = [
  "Réponds TOUJOURS en suivant exactement cette structure de réponse de tâche.",
  "Lecteur non technique : phrases simples, images concrètes, pas de jargon ni de chemins de fichiers.",
  "",
  "En-tête (avant la réponse) : une ligne annonçant le modèle utilisé (Opus = code, Codex = administratif),",
  "son niveau (Claude : de « eau » à « ultra code » ; GPT : de « eau » à « très haut »),",
  "le temps estimé et le coût approximatif (tarif : 130 CHF/h).",
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
  "Utilise des callouts colorés (> [!TIP], > [!NOTE], > [!WARNING], etc.) uniquement là où ils aident vraiment.",
  "Les icônes des titres sont ajoutées automatiquement par l'app — n'en mets pas toi-même.",
].join("\n");

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
export function injectResponseFormat(text: string): string {
  if (hasResponseFormatDirective(text)) {
    return text;
  }
  return `${OPEN_TAG}\n${RESPONSE_FORMAT_BODY}\n${CLOSE_TAG}\n\n${text}`;
}

/** Remove the leading directive envelope for display. No-op when absent. */
export function stripResponseFormat(text: string): string {
  return text.replace(RESPONSE_FORMAT_PATTERN, "");
}
