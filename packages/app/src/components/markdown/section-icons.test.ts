import { describe, expect, it } from "vitest";
import { resolveSectionIcon } from "./section-icons";

/**
 * Every heading of the three column templates (docs/response-templates.md)
 * must resolve an icon — a missing one is immediately visible in the chat.
 */
const TEMPLATE_HEADINGS: Record<string, string[]> = {
  analysis: [
    "1. Objectif",
    "2. Approche retenue",
    "3. Fichiers & points de vigilance",
    "4. Estimation",
  ],
  progress: ["1. Ce qui est fait", "2. Ce qui change", "3. Impact", "4. Évolutions possibles"],
  publication: [
    "1. Ce qui a été publié",
    "2. Déroulé de la publication",
    "3. Vérification",
    "4. Suites éventuelles",
  ],
  default: [
    "1. Ce qui est fait",
    "2. Ce qui change",
    "3. Impact",
    "4. Évolutions possibles",
    "5. Activation & facturation",
  ],
};

describe("resolveSectionIcon", () => {
  for (const [template, headings] of Object.entries(TEMPLATE_HEADINGS)) {
    it(`resolves an icon for every ${template} heading`, () => {
      for (const heading of headings) {
        expect(resolveSectionIcon(heading), heading).not.toBeNull();
      }
    });
  }

  it("returns null for an ordinary heading", () => {
    expect(resolveSectionIcon("Notes diverses")).toBeNull();
    expect(resolveSectionIcon(null)).toBeNull();
  });
});
