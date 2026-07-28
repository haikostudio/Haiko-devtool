/**
 * Detection of the conductor's "shall I make this a task?" offer.
 *
 * When a message is ambiguous — a remark that could be a simple observation or
 * a request — the chef d'orchestre answers it and closes with a single sentence
 * offering to turn it into a card, WITHOUT creating anything (see
 * `conductor-agent.ts`, family 3 of its triage). Confirming used to mean typing
 * "oui" by hand; a block detected here carries a one-click confirmation button
 * instead.
 *
 * Deliberately a plain, testable predicate over the message text: no model call,
 * no protocol field. The conductor writes the offer on its own line, so the
 * button attaches to the offer and to nothing else.
 */

/**
 * The offer: a verb of creation, then "une tâche"/"une carte", then a question
 * mark. Matching the verb AND the object AND the question keeps ordinary
 * sentences out — "J'ai créé une tâche" (no question) and "Souhaitez-vous que je
 * supprime la carte ?" (no verb of creation) both stay button-less.
 *
 * The gap allowances absorb the usual phrasings ("que j'en fasse une tâche",
 * "que je crée une tâche pour ce point") without letting a match span an entire
 * paragraph.
 */
const TASK_OFFER_PATTERN =
  /(?:fasse|fais|faire|cré[eé]?|crée|créer|crées|créez|ajoute|ajouter)\b[^?]{0,40}\bune\s+(?:t[âa]che|carte)\b[^?]{0,60}\?/i;

/** A fenced or indented code block never carries a real offer. */
function isCodeBlock(block: string): boolean {
  const trimmed = block.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~") || /^ {4}\S/.test(block);
}

/**
 * True when this markdown block is the conductor offering to turn the exchange
 * into a task. Whitespace is read flat, so an offer wrapped across two lines is
 * still recognised.
 */
export function isTaskOfferBlock(block: string): boolean {
  if (isCodeBlock(block)) {
    return false;
  }
  const flat = block.replace(/\s+/g, " ").trim();
  if (!flat.includes("?")) {
    return false;
  }
  return TASK_OFFER_PATTERN.test(flat);
}

/**
 * Flags, block by block, the ones carrying the offer. Only the LAST offer of a
 * message keeps its flag: the conductor closes with it, and a mention earlier in
 * the answer ("je pourrais en faire une tâche ?") is prose, not the offer the
 * user is meant to accept.
 */
export function flagTaskOfferBlocks(blocks: readonly string[]): boolean[] {
  const flags = blocks.map((block) => isTaskOfferBlock(block));
  const last = flags.lastIndexOf(true);
  return flags.map((flagged, index) => flagged && index === last);
}
