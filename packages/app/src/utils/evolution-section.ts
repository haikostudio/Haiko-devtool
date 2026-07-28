/**
 * Detection of the "Évolutions possibles" section in an assistant message.
 *
 * Assistant answers follow a fixed shape ("## 4. Évolutions possibles"), and
 * that section gets a richer rendering: numbered proposals, each with a button
 * that drops it into the composer. Everything else must render exactly as
 * before, so the detection is anchored rather than "contains the word".
 */

// Leading numbering ("4. ", "5) ") is stripped first, and the accent is
// optional so a model that drops it still triggers the affordance. Anchored on
// the first word so a heading that merely mentions an evolution further along
// ("Impact sur l'évolution du build") keeps plain rendering.
const EVOLUTION_HEADING_PATTERN = /^(?:\d+\s*[.)]\s*)?[ée]volution/i;

const HEADING_LINE_PATTERN = /^#{1,6}\s+(.+)$/;

export function isEvolutionHeading(headingText: string): boolean {
  return EVOLUTION_HEADING_PATTERN.test(headingText.trim().replace(/^[*_#\s]+/, ""));
}

/**
 * Flags, for each markdown block of a message, whether it belongs to the
 * "Évolutions possibles" section.
 *
 * Blocks are split on blank lines, so the section heading and its bullet list
 * are usually separate blocks: the flag has to carry over from one block to the
 * next until another heading closes the section. A heading glued to its list
 * (no blank line in between) lands in a single block, hence scanning every line
 * rather than just the first one.
 */
export function flagEvolutionBlocks(blocks: readonly string[]): boolean[] {
  let sectionIsEvolutions = false;

  return blocks.map((block) => {
    let blockIsEvolutions = sectionIsEvolutions;
    let isFirstLine = true;

    for (const line of block.trim().split("\n")) {
      const headingMatch = HEADING_LINE_PATTERN.exec(line.trim());
      if (headingMatch) {
        sectionIsEvolutions = isEvolutionHeading(headingMatch[1]);
        // Only a heading opening the block re-flags the block itself; a heading
        // further down applies to what follows.
        if (isFirstLine) {
          blockIsEvolutions = sectionIsEvolutions;
        }
      }
      isFirstLine = false;
    }

    return blockIsEvolutions;
  });
}
