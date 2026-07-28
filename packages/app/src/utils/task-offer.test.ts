import { describe, expect, it } from "vitest";
import { flagTaskOfferBlocks, isTaskOfferBlock } from "./task-offer";

describe("isTaskOfferBlock", () => {
  const offers = [
    "Souhaitez-vous que j'en fasse une tâche ?",
    "Souhaitez-vous que j'en fasse une tâche ?".toUpperCase(),
    "Voulez-vous que je crée une tâche pour ce point ?",
    "Dois-je en faire une tâche ?",
    "Je peux en faire une carte si vous voulez — souhaitez-vous que je la crée ?",
    "Faut-il que j'ajoute une tâche pour corriger ça ?",
  ];

  for (const offer of offers) {
    it(`recognises the offer: ${offer.slice(0, 48)}`, () => {
      expect(isTaskOfferBlock(offer)).toBe(true);
    });
  }

  it("recognises an offer wrapped across several lines", () => {
    const wrapped = "Souhaitez-vous que j'en\nfasse une tâche ?";
    expect(isTaskOfferBlock(wrapped)).toBe(true);
  });

  it("recognises an offer closing a longer paragraph", () => {
    const block =
      "Le chargement prend environ deux secondes, ce qui vient du chargement des images. " +
      "Souhaitez-vous que j'en fasse une tâche ?";
    expect(isTaskOfferBlock(block)).toBe(true);
  });

  const nonOffers = [
    // Already done: a report, not an offer — nothing to confirm.
    "J'ai créé une tâche « Corriger le chargement » dans À faire.",
    // A question, but not about creating anything.
    "Souhaitez-vous que je supprime la carte « Ancien menu » ?",
    // A question about tasks that offers nothing.
    "Quelle tâche voulez-vous lancer en premier ?",
    // Plain answer to a plain question.
    "Il reste trois cartes en attente dans « À faire ».",
    // The word appears, but the sentence is not a question.
    "Je peux en faire une tâche quand vous voulez.",
  ];

  for (const text of nonOffers) {
    it(`leaves it alone: ${text.slice(0, 48)}`, () => {
      expect(isTaskOfferBlock(text)).toBe(false);
    });
  }

  it("never fires inside a code block", () => {
    const fenced = "```\nSouhaitez-vous que j'en fasse une tâche ?\n```";
    expect(isTaskOfferBlock(fenced)).toBe(false);
  });
});

describe("flagTaskOfferBlocks", () => {
  it("flags the offer block and only it", () => {
    const blocks = [
      "Le chargement est effectivement lent.",
      "Souhaitez-vous que j'en fasse une tâche ?",
    ];
    expect(flagTaskOfferBlocks(blocks)).toEqual([false, true]);
  });

  it("keeps only the closing offer when the answer mentions one earlier", () => {
    const blocks = [
      "Je pourrais en faire une tâche ?",
      "Cela dit, le correctif est minuscule.",
      "Souhaitez-vous que j'en fasse une tâche ?",
    ];
    expect(flagTaskOfferBlocks(blocks)).toEqual([false, false, true]);
  });

  it("flags nothing in an answer that offers nothing", () => {
    const blocks = ["Il reste trois cartes.", "Bonne journée !"];
    expect(flagTaskOfferBlocks(blocks)).toEqual([false, false]);
  });
});
