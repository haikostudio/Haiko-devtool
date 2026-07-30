/**
 * Lecture SEULE de l'ancienne enveloppe « Cerveau » (<contexte_memoire>).
 *
 * Le rappel de mémoire longue durée a été RETIRÉ du chemin des agents : plus
 * aucun prompt n'interroge le service externe, et plus rien n'injecte ce bloc
 * (voir la suppression de services/brain-memory). Mais les transcriptions déjà
 * enregistrées, elles, contiennent encore l'enveloppe : les fournisseurs nous
 * renvoient le prompt que le démon avait réellement envoyé. Sans ce parseur, une
 * conversation d'avant la coupure réafficherait le XML brut à la place du texte
 * de l'utilisateur.
 *
 * Ce module est donc un vestige VOLONTAIRE, en lecture seule : il ne sait plus
 * fabriquer d'enveloppe, seulement en défaire une.
 */

/** Portée d'un rappel, telle qu'écrite dans les anciennes enveloppes. */
export type BrainPortee = "projet" | "global" | "apercu";

// Miroir exact de l'ancien injectBrainContext : balise ouvrante avec la portée,
// le bloc de souvenirs, la balise fermante, une ligne « Note: », une ligne vide,
// puis le texte de l'utilisateur.
const BRAIN_CONTEXT_ENVELOPE_PATTERN =
  /^<contexte_memoire source="cerveau" portee="(projet|global|apercu)">\n([\s\S]*?)\n<\/contexte_memoire>\nNote: [^\n]*\n\n([\s\S]*)$/;

const REJECTED_RECALL_LINE_PATTERN = /^⛔ \(piste écartée(?: — (.+?))?\) ([\s\S]*)$/;

export interface ParsedBrainContextEnvelope {
  portee: BrainPortee;
  memories: { texte: string; rejete?: boolean; motif?: string }[];
  userText: string;
}

/**
 * Sépare une ancienne enveloppe en « texte de l'utilisateur » + souvenirs, pour
 * que l'historique rejoué affiche la pastille d'antan plutôt que du XML.
 * Renvoie null dès que le texte n'en contient pas — le cas normal aujourd'hui.
 */
export function parseBrainContextEnvelope(text: string): ParsedBrainContextEnvelope | null {
  const match = BRAIN_CONTEXT_ENVELOPE_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  return {
    portee: match[1] as BrainPortee,
    memories: parseRecallBlob(match[2] ?? ""),
    userText: match[3] ?? "",
  };
}

/**
 * Inverse au mieux de l'ancien formatage : chaque ligne « - » / « ⛔ » ouvre un
 * souvenir, les autres prolongent le précédent (un souvenir pouvait tenir sur
 * plusieurs lignes, et le bloc pouvait être tronqué en plein milieu).
 */
function parseRecallBlob(blob: string): { texte: string; rejete?: boolean; motif?: string }[] {
  const memories: { texte: string; rejete?: boolean; motif?: string }[] = [];
  for (const line of blob.split("\n")) {
    if (line.startsWith("- ")) {
      memories.push({ texte: line.slice(2) });
      continue;
    }
    const rejected = REJECTED_RECALL_LINE_PATTERN.exec(line);
    if (rejected) {
      memories.push({
        texte: rejected[2] ?? "",
        rejete: true,
        ...(rejected[1] ? { motif: rejected[1] } : {}),
      });
      continue;
    }
    const last = memories[memories.length - 1];
    if (last) {
      last.texte = `${last.texte}\n${line}`;
    } else if (line.trim()) {
      memories.push({ texte: line });
    }
  }
  return memories.filter((memory) => memory.texte.trim().length > 0);
}
