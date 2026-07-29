/**
 * Maps a task-report section heading (e.g. "1. Ce qui est fait", "3. Impact")
 * to a lucide glyph. Used in two places so every agent's report renders the
 * same icon regardless of exact wording:
 *  - the markdown heading rule (renderer.tsx) prepends the icon to `## N. …`;
 *  - neutral callouts (message.tsx) reuse it for `> **Title**` blocks.
 *
 * Matching is keyword-based and loose on purpose — the fixed five sections
 * always resolve, and any other heading returns `null` (no icon). Because the
 * lookup keys off words and not the leading number, renumbering the sections
 * never disturbs the icons.
 */
import type { ComponentType } from "react";
import {
  Wrench,
  RefreshCw,
  Target,
  TrendingUp,
  ReceiptText,
  Route,
  FileText,
  ListChecks,
  Rocket,
  BadgeCheck,
  ClipboardCheck,
  ArrowRight,
} from "lucide-react-native";

export type SectionIcon = ComponentType<{ size?: number; color?: string }>;

/** Muted grey so the glyph reads on both light and dark themes without the
 * violet accent the user asked us to drop. Hard-coded like the callout tints. */
export const SECTION_ICON_COLOR = "#9ca3af";

// Order matters: the first match wins, so the narrower publication wordings sit
// ahead of the wide ones ("Déroulé de la publication" before "publi…").
const BY_KEYWORD: { match: RegExp; icon: SectionIcon }[] = [
  // Report sections (colonne « En cours ») + the historical five.
  { match: /fait|réalis|realis/i, icon: Wrench },
  { match: /change|modif/i, icon: RefreshCw },
  { match: /impact/i, icon: Target },
  { match: /évolu|evolu|amélior|ameli|piste|prochaine/i, icon: TrendingUp },
  { match: /factur|tarif|activ/i, icon: ReceiptText },
  // Analysis sections (colonne « Validé »).
  { match: /objectif|but /i, icon: Target },
  { match: /approche|méthode|methode|plan/i, icon: Route },
  { match: /fichier|vigilance|risque/i, icon: FileText },
  { match: /estimation|temps|coût|cout|devis/i, icon: ReceiptText },
  // Publication sections (colonne « Déployé »).
  { match: /déroul|deroul|étape|etape|journal/i, icon: ListChecks },
  { match: /publi|mise en ligne|déploie|deploie/i, icon: Rocket },
  // Verification sections (contrôle final) — the "résultat/verdict" wording sits
  // ahead of the wide "contrôl" match so the verdict gets its own glyph rather
  // than reusing the BadgeCheck of "Ce qui a été vérifié".
  { match: /verdict|résultat|resultat|bilan/i, icon: ClipboardCheck },
  { match: /vérif|verif|contrôl|control/i, icon: BadgeCheck },
  { match: /suite|surveill|à venir|a venir/i, icon: ArrowRight },
];

/** Returns the section icon for a heading, or `null` for non-report headings. */
export function resolveSectionIcon(heading: string | null | undefined): SectionIcon | null {
  if (!heading) return null;
  for (const entry of BY_KEYWORD) {
    if (entry.match.test(heading)) return entry.icon;
  }
  return null;
}
