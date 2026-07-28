import { describe, expect, it } from "vitest";
import { detectPendingUserQuestion } from "./agent-pending-question.js";

describe("detectPendingUserQuestion", () => {
  it("spots a plain closing question", () => {
    expect(
      detectPendingUserQuestion("J'ai deux options possibles.\n\nLaquelle préfères-tu ?"),
    ).toBe(true);
  });

  it("spots a closing question wrapped in markdown emphasis", () => {
    expect(detectPendingUserQuestion("Tout est prêt.\n\n**On publie maintenant ?**")).toBe(true);
  });

  it("spots an explicit hand-back with no question mark", () => {
    expect(detectPendingUserQuestion("Le correctif est prêt.\n\nDis-moi si je continue.")).toBe(
      true,
    );
    expect(detectPendingUserQuestion("Everything is staged.\n\nLet me know when to push.")).toBe(
      true,
    );
  });

  it("stays quiet on a finished-work report", () => {
    const report = [
      "## 1. Ce qui est fait",
      "Le badge affiche désormais « Terminé » quand rien n'est attendu.",
      "",
      "## 5. Activation & facturation",
      "Temps réel : ~9 minutes · taux : 130 CHF/h · coût : ~20 CHF.",
    ].join("\n");
    expect(detectPendingUserQuestion(report)).toBe(false);
  });

  it("ignores a question mark buried in the middle of a long report", () => {
    const report = [
      "J'ai commencé par me demander : fallait-il vraiment toucher au serveur ?",
      "La réponse était non, alors j'ai corrigé la logique côté application.",
      "Les tests passent, le style est propre, et la carte est prête.",
      "Rien d'autre à signaler.",
    ].join("\n");
    expect(detectPendingUserQuestion(report)).toBe(false);
  });

  it("ignores question marks that are only code punctuation", () => {
    const message = [
      "Voici le correctif appliqué :",
      "```ts",
      "const label = tone === 'done' ? 'Terminé' : null;",
      "```",
      "Le code est committé.",
    ].join("\n");
    expect(detectPendingUserQuestion(message)).toBe(false);
    expect(detectPendingUserQuestion("Rien à signaler. `a?.b ?? c`")).toBe(false);
  });

  it("does not mistake a narrated past action for a request", () => {
    expect(
      detectPendingUserQuestion("J'ai validé le résultat et confirmé que tout est en ligne."),
    ).toBe(false);
  });

  it("returns false on an empty or whitespace-only message", () => {
    expect(detectPendingUserQuestion("")).toBe(false);
    expect(detectPendingUserQuestion("   \n\n  ")).toBe(false);
  });

  it("reads the tail of a very long message", () => {
    const long = `${"Une ligne de compte rendu.\n".repeat(500)}\nTu confirmes la publication ?`;
    expect(detectPendingUserQuestion(long)).toBe(true);
  });
});
