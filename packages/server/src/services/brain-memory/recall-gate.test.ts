import { describe, expect, test } from "vitest";
import { hasRecallSubstance } from "./recall-gate.js";

describe("hasRecallSubstance", () => {
  test.each([
    "Ajoute un bandeau en haut de l'application",
    "Il faut corriger le redirect du login",
    "déploie le site vitrine en prod",
    "refactor the sidebar dashboard layout",
    "pourquoi le clavier cache le header du sheet ?",
  ])("substantial: %s", (text) => {
    expect(hasRecallSubstance(text)).toBe(true);
  });

  test.each([
    "Oui",
    "oui clairement",
    "ok",
    "OK vas-y",
    "vas-y",
    "merci !",
    "parfait, continue",
    "d'accord",
    "go ahead",
    "yes please",
    "super, merci",
    "",
    "   ",
  ])("no substance: %s", (text) => {
    expect(hasRecallSubstance(text)).toBe(false);
  });
});
