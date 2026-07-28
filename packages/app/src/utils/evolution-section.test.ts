import { describe, expect, it } from "vitest";
import {
  flagEvolutionBlocks,
  isEvolutionHeading,
  normalizeEvolutionBlock,
  splitBlocksAtHeadings,
} from "./evolution-section";
import { splitMarkdownBlocks } from "./split-markdown-blocks";

/**
 * The renderer hangs the "+" button on list items of the flagged blocks, so a
 * proposal is actionable exactly when the pipeline (split → flag → normalize)
 * turns its line into a list item. These helpers assert that end state, which
 * is the behaviour the user sees.
 */
function evolutionLines(message: string): string[] {
  const blocks = splitBlocksAtHeadings(splitMarkdownBlocks(message));
  const flags = flagEvolutionBlocks(blocks);
  return blocks
    .filter((_, index) => flags[index])
    .flatMap((block) => normalizeEvolutionBlock(block).split("\n"))
    .filter((line) => line.trim().length > 0);
}

function actionableProposals(message: string): string[] {
  return evolutionLines(message)
    .filter((line) => /^ {0,3}(?:[-*+]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^ {0,3}(?:[-*+]|\d+[.)])\s+/, "").trim());
}

describe("isEvolutionHeading", () => {
  it("matches the canonical numbered heading", () => {
    expect(isEvolutionHeading("4. Évolutions possibles")).toBe(true);
  });

  it("matches without numbering, without accent, and in caps", () => {
    expect(isEvolutionHeading("Évolutions possibles")).toBe(true);
    expect(isEvolutionHeading("5) Evolutions")).toBe(true);
    expect(isEvolutionHeading("ÉVOLUTIONS POSSIBLES")).toBe(true);
  });

  it("ignores bold markers around the heading", () => {
    expect(isEvolutionHeading("**Évolutions possibles**")).toBe(true);
  });

  it("does not match other sections", () => {
    expect(isEvolutionHeading("1. Ce qui est fait")).toBe(false);
    expect(isEvolutionHeading("5. Activation & facturation")).toBe(false);
  });

  it("does not match a heading that merely mentions an evolution", () => {
    expect(isEvolutionHeading("Impact sur l'évolution du build")).toBe(false);
  });
});

describe("flagEvolutionBlocks", () => {
  it("flags the blocks that follow the heading until the next section", () => {
    const message = [
      "## 1. Ce qui est fait",
      "- point A",
      "## 4. Évolutions possibles",
      "- piste 1",
      "- piste 2",
      "Un paragraphe encore dans la section.",
      "## 5. Activation & facturation",
      "- ligne de facture",
    ].join("\n\n");

    const blocks = splitMarkdownBlocks(message);
    const flags = flagEvolutionBlocks(blocks);

    const flaggedBlocks = blocks.filter((_, index) => flags[index]);
    expect(flaggedBlocks).toEqual([
      "## 4. Évolutions possibles",
      "- piste 1",
      "- piste 2",
      "Un paragraphe encore dans la section.",
    ]);
  });

  it("flags a heading glued to its list in a single block", () => {
    const flags = flagEvolutionBlocks(["## 4. Évolutions possibles\n- piste 1\n- piste 2"]);
    expect(flags).toEqual([true]);
  });

  it("does not flag a block whose evolution heading only starts halfway through", () => {
    const flags = flagEvolutionBlocks([
      "- une liste ordinaire\n## 4. Évolutions possibles",
      "- piste 1",
    ]);
    expect(flags).toEqual([false, true]);
  });

  it("leaves a message without the section untouched", () => {
    const flags = flagEvolutionBlocks(["## 1. Ce qui est fait", "- point A", "- point B"]);
    expect(flags).toEqual([false, false, false]);
  });

  it("closes the section on the next heading", () => {
    const flags = flagEvolutionBlocks([
      "## 4. Évolutions possibles",
      "- piste 1",
      "## 5. Activation & facturation",
      "- ligne",
    ]);
    expect(flags).toEqual([true, true, false, false]);
  });
});

describe("splitBlocksAtHeadings", () => {
  it("cuts a block so a heading always opens one", () => {
    expect(splitBlocksAtHeadings(["- une liste\n## 4. Évolutions possibles\n- piste 1"])).toEqual([
      "- une liste",
      "## 4. Évolutions possibles\n- piste 1",
    ]);
  });

  it("leaves a block without heading untouched", () => {
    expect(splitBlocksAtHeadings(["- a\n- b"])).toEqual(["- a\n- b"]);
  });

  it("never cuts inside a code fence", () => {
    const fenced = "```md\n## pas un titre\n```";
    expect(splitBlocksAtHeadings([fenced])).toEqual([fenced]);
  });
});

describe("normalizeEvolutionBlock", () => {
  it("turns a bare paragraph line into a list item", () => {
    expect(normalizeEvolutionBlock("Ajouter un voyant de retard.")).toBe(
      "- Ajouter un voyant de retard.",
    );
  });

  it("leaves bullets, numbered items and headings alone", () => {
    const block = "## 4. Évolutions possibles\n- piste 1\n2. piste 2\n* piste 3";
    expect(normalizeEvolutionBlock(block)).toBe(block);
  });

  it("leaves tables, quotes and indented continuations alone", () => {
    const block = "| a | b |\n> [!TIP]\n  suite indentée";
    expect(normalizeEvolutionBlock(block)).toBe(block);
  });

  it("leaves a block containing a code fence entirely alone", () => {
    const block = "```\nune commande\n```";
    expect(normalizeEvolutionBlock(block)).toBe(block);
  });
});

describe("every formatting variant yields an actionable proposal", () => {
  const proposals = ["Ajouter un voyant de retard", "Grouper les publications"];

  it("bullets", () => {
    const message =
      "## 4. Évolutions possibles\n\n- Ajouter un voyant de retard\n- Grouper les publications";
    expect(actionableProposals(message)).toEqual(proposals);
  });

  it("numbered list", () => {
    const message =
      "## 4. Évolutions possibles\n\n1. Ajouter un voyant de retard\n2. Grouper les publications";
    expect(actionableProposals(message)).toEqual(proposals);
  });

  it("bold lines without any bullet", () => {
    const message =
      "## 4. Évolutions possibles\n\n**Ajouter un voyant de retard**\n\n**Grouper les publications**";
    expect(actionableProposals(message)).toEqual([
      "**Ajouter un voyant de retard**",
      "**Grouper les publications**",
    ]);
  });

  it("bare sentences, one per line", () => {
    const message =
      "## 4. Évolutions possibles\n\nAjouter un voyant de retard\nGrouper les publications";
    expect(actionableProposals(message)).toEqual(proposals);
  });

  it("bullets with a bold lead-in", () => {
    const message =
      "## 4. Évolutions possibles\n\n- **Voyant de retard** — prévenir quand ça traîne\n- **Publication groupée** — une seule mise en ligne";
    expect(actionableProposals(message)).toEqual([
      "**Voyant de retard** — prévenir quand ça traîne",
      "**Publication groupée** — une seule mise en ligne",
    ]);
  });

  it("a dense answer written without blank lines around the headings", () => {
    const message = [
      "## 3. Impact",
      "Tout va bien.",
      "## 4. Évolutions possibles",
      "- Ajouter un voyant de retard",
      "- Grouper les publications",
      "## 5. Activation & facturation",
      "1 h × 130 CHF",
    ].join("\n");
    expect(actionableProposals(message)).toEqual(proposals);
  });

  it("the section heading itself never becomes a proposal", () => {
    const message = "## 4. Évolutions possibles\n\n- Ajouter un voyant de retard";
    expect(actionableProposals(message)).toEqual(["Ajouter un voyant de retard"]);
  });

  it("lines of the other sections stay out of it", () => {
    const message = [
      "## 1. Ce qui est fait",
      "Le travail est livré.",
      "## 4. Évolutions possibles",
      "Ajouter un voyant de retard",
      "## 5. Activation & facturation",
      "Facture à envoyer",
    ].join("\n\n");
    expect(actionableProposals(message)).toEqual(["Ajouter un voyant de retard"]);
  });
});
