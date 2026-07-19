/**
 * Maps a task-report section heading (e.g. "1. Ce qui est fait", "3. Impact")
 * to a lucide glyph. Used in two places so every agent's report renders the
 * same icon regardless of exact wording:
 *  - the markdown heading rule (renderer.tsx) prepends the icon to `## N. …`;
 *  - neutral callouts (message.tsx) reuse it for `> **Title**` blocks.
 *
 * Matching is keyword-based and loose on purpose — the fixed six sections
 * always resolve, and any other heading returns `null` (no icon).
 */
import type { ComponentType } from "react";
import {
  Wrench,
  RefreshCw,
  Target,
  MessageSquare,
  TrendingUp,
  ReceiptText,
} from "lucide-react-native";

export type SectionIcon = ComponentType<{ size?: number; color?: string }>;

/** Muted grey so the glyph reads on both light and dark themes without the
 * violet accent the user asked us to drop. Hard-coded like the callout tints. */
export const SECTION_ICON_COLOR = "#9ca3af";

const BY_KEYWORD: { match: RegExp; icon: SectionIcon }[] = [
  { match: /fait|réalis|realis/i, icon: Wrench },
  { match: /change|modif/i, icon: RefreshCw },
  { match: /impact/i, icon: Target },
  { match: /expliqu|tiers|client|simplement|vulgaris/i, icon: MessageSquare },
  { match: /évolu|evolu|amélior|ameli|piste|prochaine/i, icon: TrendingUp },
  { match: /factur|temps|coût|cout|tarif|activ/i, icon: ReceiptText },
];

/** Returns the section icon for a heading, or `null` for non-report headings. */
export function resolveSectionIcon(heading: string | null | undefined): SectionIcon | null {
  if (!heading) return null;
  for (const entry of BY_KEYWORD) {
    if (entry.match.test(heading)) return entry.icon;
  }
  return null;
}
