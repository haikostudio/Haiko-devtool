/**
 * Context captured alongside a dispatched push so the mobile history panel can
 * show which task the notification is about, which project it belongs to, and a
 * short recap of what happened. Every field is optional: notifications that are
 * not agent-bound (terminals, task proposals) simply carry none of it.
 */
export interface PushHistoryContext {
  /** Title of the task/agent concerned. */
  taskTitle?: string | null;
  /** Display name of the project the task belongs to. */
  projectName?: string | null;
  /** Short recap, already clamped to at most 3 sentences. */
  summary?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
}

const DEFAULT_MAX_SENTENCES = 3;

/**
 * Clamp a synthesis summary to whole sentences.
 *
 * The banner summary is already a sentence-aware condensation of the last
 * message (see `agent-synthesis-builder.ts`); the history row only needs the
 * first few sentences of it. Cutting on sentence boundaries — never mid-word —
 * is what keeps this different from a raw substring: the row reads as prose.
 *
 * Returns null when there is nothing usable, so callers can omit the field.
 */
export function clampToSentences(
  text: string | null | undefined,
  maxSentences: number = DEFAULT_MAX_SENTENCES,
): string | null {
  if (typeof text !== "string") {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || maxSentences <= 0) {
    return null;
  }

  // Split after ., !, ? or … when followed by whitespace. Anything without
  // terminal punctuation is a single sentence and comes back untouched.
  const sentences = normalized.match(/[^.!?…]+(?:[.!?…]+|$)/g);
  if (!sentences || sentences.length <= maxSentences) {
    return normalized;
  }

  return sentences
    .slice(0, maxSentences)
    .map((sentence) => sentence.trim())
    .join(" ")
    .trim();
}

export type NormalizedPushHistoryContext = Partial<Record<keyof PushHistoryContext, string>>;

/** Drop empty/blank fields so the wire entry only carries real values. */
export function normalizePushHistoryContext(
  context: PushHistoryContext | undefined,
): NormalizedPushHistoryContext {
  if (!context) {
    return {};
  }
  const normalized: NormalizedPushHistoryContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      normalized[key as keyof PushHistoryContext] = trimmed;
    }
  }
  return normalized;
}
