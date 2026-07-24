// Maps raw Claude SDK / CLI crash messages to short, readable French sentences
// so a non-developer sees "La connexion à Claude a été perdue — réessaie."
// instead of a raw stack-trace fragment like
// "Cannot read properties of null (reading 'push')".
//
// The original technical message is not thrown away — callers keep it for the
// daemon logs / diagnostic field. Only the user-facing `error` string is
// rewritten.

/** Default message used for any SDK failure we do not specifically recognize. */
export const DEFAULT_CLAUDE_ERROR_MESSAGE = "La connexion à Claude a été perdue — réessaie.";

interface ClaudeErrorMapping {
  /** Matches against the raw SDK error message (case-insensitive). */
  readonly match: RegExp;
  /** Readable French sentence shown to the user. */
  readonly message: string;
}

// Ordered list — the first mapping whose pattern matches wins. Keep the most
// specific patterns first. All patterns are matched case-insensitively.
const CLAUDE_ERROR_MAPPINGS: readonly ClaudeErrorMapping[] = [
  {
    // Internal SDK crash: null/undefined property access
    // (e.g. "Cannot read properties of null (reading 'push')").
    match: /cannot read properties of (?:null|undefined)/i,
    message: DEFAULT_CLAUDE_ERROR_MESSAGE,
  },
  {
    match: /is not a function|is not defined|undefined is not an object/i,
    message: DEFAULT_CLAUDE_ERROR_MESSAGE,
  },
  {
    // Stream / connection dropped mid-turn.
    match: /stream (?:closed|ended|disconnected)|premature close|socket hang up|econnreset|epipe/i,
    message: DEFAULT_CLAUDE_ERROR_MESSAGE,
  },
  {
    // Network reachability.
    match: /enotfound|eai_again|etimedout|econnrefused|network error|fetch failed/i,
    message: "Impossible de joindre Claude — vérifie ta connexion internet, puis réessaie.",
  },
  {
    // Auth / credentials.
    match: /\b401\b|unauthorized|authentication|invalid api key|not logged in|please log in/i,
    message: "La connexion à ton compte Claude a expiré — reconnecte-toi, puis réessaie.",
  },
  {
    // Rate limit / quota.
    match: /\b429\b|rate limit|too many requests|quota|usage limit/i,
    message: "Tu as atteint la limite d'utilisation de Claude — patiente un moment, puis réessaie.",
  },
  {
    // Overloaded / server-side unavailability.
    match: /\b5\d{2}\b|overloaded|service unavailable|internal server error|bad gateway/i,
    message: "Claude est momentanément surchargé — réessaie dans quelques instants.",
  },
  {
    // Model context window exceeded.
    match: /context (?:window|length)|too many tokens|maximum context|prompt is too long/i,
    message: "La conversation est devenue trop longue pour Claude — démarre une nouvelle tâche.",
  },
  {
    // CLI binary could not start / missing.
    match: /process exited with code|command not found|enoent|no preset version|spawn/i,
    message: "Claude n'a pas pu démarrer — réessaie, et vérifie qu'il est bien installé.",
  },
  {
    // Timeout waiting on the provider.
    match: /timed? ?out|timeout/i,
    message: "Claude a mis trop de temps à répondre — réessaie.",
  },
];

/**
 * Returns `true` for messages that were cancelled by the user — these should be
 * surfaced as-is by the caller, not rewritten into an error sentence.
 */
export function isClaudeAbortMessage(rawMessage: string): boolean {
  return /\baborted\b|\bcancell?ed\b|\binterrupted\b/i.test(rawMessage);
}

// Signatures of raw JavaScript/runtime crashes that must never reach the user
// verbatim — a stack frame, a TypeError/ReferenceError, an unhandled rejection.
// Anything matching this but not matching a specific mapping above falls back to
// the generic default message.
const RAW_JS_CRASH_SIGNATURE =
  /\b(?:TypeError|ReferenceError|RangeError|SyntaxError|Unhandled(?:Promise)?Rejection)\b|\n\s*at\s|\bundefined\b|\bnull\b/;

/**
 * Converts a raw Claude SDK/CLI failure message into a short, readable French
 * sentence understandable by a non-developer.
 *
 * - Known crash/operational patterns are mapped to French sentences.
 * - Raw JavaScript runtime crashes fall back to {@link DEFAULT_CLAUDE_ERROR_MESSAGE}.
 * - Messages that are already explicit, human-readable sentences (e.g. a
 *   deliberate provider validation message) are passed through unchanged so we
 *   never hide useful guidance behind the generic default.
 */
export function toReadableClaudeError(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  if (trimmed.length === 0) {
    return DEFAULT_CLAUDE_ERROR_MESSAGE;
  }
  for (const mapping of CLAUDE_ERROR_MAPPINGS) {
    if (mapping.match.test(trimmed)) {
      return mapping.message;
    }
  }
  if (RAW_JS_CRASH_SIGNATURE.test(trimmed)) {
    return DEFAULT_CLAUDE_ERROR_MESSAGE;
  }
  return trimmed;
}
