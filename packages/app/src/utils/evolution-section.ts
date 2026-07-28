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
const FENCE_LINE_PATTERN = /^\s*(?:```|~~~)/;
// A top-level list item: "- x", "* x", "+ x", "1. x", "2) x". Up to three
// leading spaces still counts as top level in Markdown.
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/;
// Anything already structured that must never be turned into a bullet: a table
// row, a quote/callout, an indented continuation line.
const STRUCTURAL_LINE_PATTERN = /^(?:\s{2,}|\s*[|>])/;

/**
 * Splits blocks so a heading ALWAYS starts a block.
 *
 * Blocks come out of {@link splitMarkdownBlocks} split on blank lines only, so
 * an answer written without a blank line before "## 4. Évolutions possibles"
 * (or a whole answer written as one dense block) buries the heading in the
 * middle of a block — and {@link flagEvolutionBlocks} only re-flags a block
 * when the heading opens it, so the section silently loses its "+" buttons.
 * Cutting before every heading removes that whole class of misses.
 *
 * Fenced blocks are left alone: a "#" inside a code sample is not a heading.
 */
export function splitBlocksAtHeadings(blocks: readonly string[]): string[] {
  const result: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.some((line) => FENCE_LINE_PATTERN.test(line))) {
      result.push(block);
      continue;
    }

    let current: string[] = [];
    for (const line of lines) {
      if (current.length > 0 && HEADING_LINE_PATTERN.test(line.trim())) {
        result.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) {
      result.push(current.join("\n"));
    }
  }

  return result;
}

/**
 * Rewrites a block of the evolutions section so every proposal is a list item.
 *
 * The "+" affordance hangs off list items, so a proposal written as a plain
 * paragraph line — "**Notifier l'utilisateur** — quand la publication traîne" —
 * used to get no button at all. Rather than teaching the renderer about every
 * shape a model may produce, the shapes are normalized here: bullets, numbered
 * items, bold lines and bare sentences all end up as list items, and the
 * renderer keeps its single rule.
 *
 * Left untouched: headings, blocks containing a code fence, table rows, quotes,
 * indented continuations and lines that are already list items.
 */
export function normalizeEvolutionBlock(block: string): string {
  const lines = block.split("\n");
  if (lines.some((line) => FENCE_LINE_PATTERN.test(line))) {
    return block;
  }

  let changed = false;
  const normalized = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return line;
    }
    if (
      HEADING_LINE_PATTERN.test(trimmed) ||
      LIST_ITEM_PATTERN.test(line) ||
      STRUCTURAL_LINE_PATTERN.test(line)
    ) {
      return line;
    }
    changed = true;
    return `- ${trimmed}`;
  });

  return changed ? normalized.join("\n") : block;
}

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
