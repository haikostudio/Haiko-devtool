import type { AgentSynthesis } from "@getpaseo/protocol/messages";

/**
 * One conversation turn, role-tagged. Contiguous same-role chunks (Claude
 * streams assistant text in pieces) are expected to be merged upstream.
 */
export interface SynthesisTurn {
  role: "user" | "assistant";
  text: string;
}

export interface BuildAgentSynthesisOptions {
  /** Ordered conversation turns, oldest first. */
  turns: readonly SynthesisTurn[];
  /** Agent lifecycle status (`agent.lifecycle`), used for the "state" line. */
  status?: string;
  /** ISO timestamp stamped on the result. */
  now: string;
}

// Display budgets for the floating banner. The wire schema (`AgentSynthesisSchema`)
// is an unbounded string and the collapsed banner clamps the summary to two
// lines, so these are generous, sentence-aware trims — never a validation gate.
const SUMMARY_MAX = 240;
const OBJECTIVE_MAX = 140;

/**
 * Build the floating conversation-synthesis block deterministically from the
 * transcript — no LLM, instant, free, and it never fails. The banner answers
 * "what is this agent on right now?", so we extract rather than paraphrase:
 *
 * - `summary`   — the latest message (yours on send, the agent's after a turn),
 *   so the block changes on every interaction.
 * - `objective` — the first user message: the running through-line / original ask.
 * - `state`     — where things stand, from the live lifecycle status.
 *
 * Returns null when there is nothing to summarize yet (empty transcript).
 */
export function buildAgentSynthesis(options: BuildAgentSynthesisOptions): AgentSynthesis | null {
  const turns = options.turns.filter((turn) => turn.text.trim().length > 0);
  if (turns.length === 0) {
    return null;
  }

  const last = turns[turns.length - 1];
  const summary = condense(last.text, SUMMARY_MAX);
  if (!summary) {
    return null;
  }

  const firstUser = turns.find((turn) => turn.role === "user");
  const objective = firstUser ? condense(firstUser.text, OBJECTIVE_MAX) : null;

  return {
    summary,
    // Drop the objective when it would just repeat the summary (single-message
    // conversations), so the expanded card doesn't show the same line twice.
    objective: objective && objective !== summary ? objective : null,
    state: describeState(options.status, last.role),
    updatedAt: options.now,
  };
}

function describeState(status: string | undefined, lastRole: "user" | "assistant"): string | null {
  switch (status) {
    case "running":
      return "L'agent travaille…";
    case "error":
      return "Erreur au dernier tour";
    case "initializing":
      return "Démarrage…";
    case "closed":
      return "Session fermée";
    default:
      // idle / unknown: describe from which side spoke last.
      return lastRole === "assistant" ? "Réponse reçue" : "En attente de traitement";
  }
}

/**
 * Collapse whitespace and trim to a budget, preferring a clean sentence boundary
 * and falling back to a word boundary with an ellipsis. Purely deterministic.
 */
function condense(raw: string, max: number): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  const slice = normalized.slice(0, max);
  const boundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (boundary >= max * 0.5) {
    return slice.slice(0, boundary + 1).trim();
  }
  const space = slice.lastIndexOf(" ");
  const cut = space > max * 0.5 ? slice.slice(0, space) : slice;
  return `${cut.trim()}…`;
}
