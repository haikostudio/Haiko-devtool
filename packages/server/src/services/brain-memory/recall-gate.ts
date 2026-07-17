import { foldStems } from "./client.js";

/**
 * Substance gate for Cerveau recall on follow-up prompts. The recall query is
 * the user's raw text, so a bare confirmation ("Oui", "ok vas-y", "merci") used
 * to run a semantic search on… "Oui" and inject whatever noise came back. A
 * follow-up only deserves a recall when it introduces actual content — the
 * first prompt of a conversation bypasses this gate entirely (it always gets
 * the project brief + a recall).
 */

// Filler stems (folded + stemmed like foldStems output: accents dropped,
// trailing -s/-x removed on >4-char words). Words under 4 chars ("oui", "ok",
// "go", "non", "yes") never survive foldStems, so they don't need listing.
const FILLER_STEMS = new Set([
  // FR
  "merci",
  "parfait",
  "super",
  "nickel",
  "genial",
  "impeccable",
  "accord",
  "daccord",
  "continue",
  "encore",
  "voila",
  "allez",
  "allon",
  "attend",
  "exactement",
  "clairement",
  "carrement",
  "evidemment",
  "bien",
  "bonne",
  "tres",
  "cool",
  "okay",
  "ouai",
  "enchaine",
  "lance",
  "vasy",
  "fonce",
  // EN
  "please",
  "thank",
  "great",
  "nice",
  "perfect",
  "sure",
  "sound",
  "good",
  "proceed",
  "ahead",
]);

/**
 * True when the text carries enough meaningful content to anchor a recall:
 * at least two non-filler stems ("ajoute un bandeau" → "ajoute", "bandeau").
 */
export function hasRecallSubstance(text: string): boolean {
  const meaningful = foldStems(text).filter((stem) => !FILLER_STEMS.has(stem));
  return meaningful.length >= 2;
}
