import { describe, expect, it } from "vitest";
import { flagEvolutionBlocks, isEvolutionHeading } from "./evolution-section";
import { splitMarkdownBlocks } from "./split-markdown-blocks";

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
