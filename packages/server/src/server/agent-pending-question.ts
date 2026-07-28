/**
 * "Is the agent actually waiting on the user?" — a deterministic read of the
 * last assistant message.
 *
 * The lifecycle flags only say an agent STOPPED (`requiresAttention` with an
 * attentionReason of "finished"), never whether it stopped *asking something*.
 * A permission prompt is explicit and lands in its own bucket; a question typed
 * in plain prose is not, so a card had no way to tell "j'ai fini" from "je te
 * demande quelque chose". This closes that gap without an LLM: same input →
 * same answer, instant, free, and it can never fail mid-turn.
 *
 * The rule is deliberately narrow — a false "the agent needs you" is exactly the
 * lie this detector exists to stop telling:
 *
 *  - Only the END of the message counts. Questions live in the closing lines
 *    ("Tu préfères laquelle ?"); a question mark buried in the middle of a long
 *    report is almost always rhetorical or a quoted requirement.
 *  - Code is stripped first. A "?" inside a snippet (ternaries, optional
 *    chaining, query strings, regexes) is punctuation, not a question.
 *  - Beyond a literal question mark, only explicit hand-backs count ("dis-moi
 *    laquelle", "let me know", "j'ai besoin de ton accord") — phrased as an
 *    instruction to the reader, not as a description of what the agent did.
 */

// Only the closing lines of the message are inspected — see the rule above.
const TAIL_LINES = 3;
// Cap the work on very long messages: the tail is all we read anyway.
const TAIL_CHARS = 4000;

// Trailing decoration a sentence can end with after its "?" — markdown emphasis,
// closing quotes/brackets, the French closing guillemet.
const TRAILING_DECORATION = /[\s*_`~"'’»)\]]+$/;

// Explicit hand-backs that carry no question mark ("Dis-moi laquelle tu
// préfères."). Anchored to a sentence/line start where the phrasing is an
// imperative, so a narrated "j'ai validé le résultat" never trips them.
const LINE_START = String.raw`(?:^|[.!?;:]\s+|\n)\s*(?:[-*+>]\s*|\d+[.)]\s*)?`;
const REQUEST_PATTERNS: readonly RegExp[] = [
  // French imperatives handing the ball back.
  new RegExp(`${LINE_START}(?:dis|dites)[- ]moi\\b`, "i"),
  new RegExp(
    `${LINE_START}(?:confirme|confirmez|valide|validez|choisis|choisissez|précise|précisez|indique|indiquez|réponds|répondez)\\b`,
    "i",
  ),
  /\bà (?:toi|vous) de (?:choisir|décider|voir|jouer|trancher)\b/i,
  /\b(?:j'ai|il me faut) besoin (?:de |d')(?:ton |votre )?(?:accord|feu vert|validation|décision|réponse|choix|précision)/i,
  /\b(?:préviens|prévenez|fais|faites)[- ](?:moi )?signe\b/i,
  // English equivalents.
  /\blet me know\b/i,
  new RegExp(
    `${LINE_START}please (?:confirm|choose|decide|clarify|specify|tell me|let me know|provide|pick)\\b`,
    "i",
  ),
  /\bwhich (?:one )?(?:do|would) you (?:prefer|want)\b/i,
  /\bi need (?:your|a) (?:decision|answer|confirmation|input|go-ahead|call)\b/i,
  /\byour call\b/i,
];

/**
 * True when the message hands the conversation back to the user — a question or
 * an explicit ask. False for a plain report of finished work.
 */
export function detectPendingUserQuestion(text: string): boolean {
  const tail = closingLines(text);
  if (tail.length === 0) {
    return false;
  }
  if (tail.some(endsWithQuestionMark)) {
    return true;
  }
  const joined = tail.join("\n");
  return REQUEST_PATTERNS.some((pattern) => pattern.test(joined));
}

function endsWithQuestionMark(line: string): boolean {
  return line.replace(TRAILING_DECORATION, "").endsWith("?");
}

/**
 * The last few meaningful lines, with code removed. Fenced blocks go first (a
 * fence can span many lines), then inline spans.
 */
function closingLines(text: string): string[] {
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  const tail = withoutCode.length > TAIL_CHARS ? withoutCode.slice(-TAIL_CHARS) : withoutCode;
  const lines = tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(-TAIL_LINES);
}
