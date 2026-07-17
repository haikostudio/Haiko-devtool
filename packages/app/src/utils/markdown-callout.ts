/**
 * Detects "callout" blocks in assistant markdown so the message thread can
 * lift advice, notes and warnings out of the wall of prose. A callout is any
 * markdown blockquote. Plain blockquotes render as a purple accent (advice);
 * GitHub-style alert markers (`> [!TIP]`, `> [!WARNING]`, …) get a typed color
 * plus a labelled header. See docs/design.md for the rationale.
 */

export type CalloutType = "tip" | "note" | "important" | "warning" | "caution";

export interface ParsedCallout {
  /** Drives the accent color and icon. */
  type: CalloutType;
  /**
   * Header label to show above the body. `null` for a plain blockquote (no
   * marker) — we tint it but don't slap a potentially-wrong label on a quote.
   */
  heading: string | null;
  /** Inner markdown with the blockquote markers and any alert line removed. */
  body: string;
}

/**
 * Alert markers → callout type. Keyed by the upper-cased marker word so both
 * the GitHub set and a few French aliases resolve. New keys must map onto an
 * existing {@link CalloutType} so the color/icon table stays exhaustive.
 */
const ALERT_MARKERS: Record<string, CalloutType> = {
  TIP: "tip",
  CONSEIL: "tip",
  ASTUCE: "tip",
  NOTE: "note",
  INFO: "note",
  IMPORTANT: "important",
  WARNING: "warning",
  ATTENTION: "warning",
  CAUTION: "caution",
  DANGER: "caution",
};

// Matches a leading `[!TYPE]` alert marker, capturing the type word and any
// inline title that follows it on the same line.
const ALERT_LINE = /^\[!\s*([A-Za-zÀ-ÿ]+)\s*\]\s*(.*)$/;

// Matches (and strips) one level of `>` blockquote prefix, tolerating up to
// three leading spaces per CommonMark.
const BLOCKQUOTE_PREFIX = /^\s{0,3}>\s?(.*)$/;

function stripLeadingBlankLines(lines: string[]): void {
  while (lines.length > 0 && lines[0].trim().length === 0) {
    lines.shift();
  }
}

/**
 * Returns the callout descriptor for a markdown block, or `null` when the block
 * is not a blockquote. Operates on a single block as produced by
 * `splitMarkdownBlocks` (blockquote lines are contiguous, so they land in one
 * block).
 */
export function parseCalloutBlock(block: string): ParsedCallout | null {
  const rawLines = block.split("\n");
  const firstNonEmpty = rawLines.find((line) => line.trim().length > 0);
  if (firstNonEmpty === undefined || !/^\s{0,3}>/.test(firstNonEmpty)) {
    return null;
  }

  // Peel off one blockquote level. Lazy-continuation lines (no `>`) are kept
  // verbatim, matching how CommonMark folds them into the quote.
  const innerLines = rawLines.map((line) => {
    const match = BLOCKQUOTE_PREFIX.exec(line);
    return match ? match[1] : line;
  });
  stripLeadingBlankLines(innerLines);

  let type: CalloutType = "tip";
  let heading: string | null = null;

  const alertMatch = ALERT_LINE.exec((innerLines[0] ?? "").trim());
  if (alertMatch) {
    const mapped = ALERT_MARKERS[alertMatch[1].toUpperCase()];
    if (mapped) {
      type = mapped;
      const inlineTitle = alertMatch[2].trim();
      heading = inlineTitle.length > 0 ? inlineTitle : DEFAULT_HEADINGS[mapped];
      innerLines.shift();
      stripLeadingBlankLines(innerLines);
    }
  }

  return { type, heading, body: innerLines.join("\n").trimEnd() };
}

/** Default header label per type, used when an alert carries no inline title. */
export const DEFAULT_HEADINGS: Record<CalloutType, string> = {
  tip: "Conseil",
  note: "Note",
  important: "Important",
  warning: "Attention",
  caution: "Danger",
};
