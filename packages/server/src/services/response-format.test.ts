import { describe, expect, it } from "vitest";

import {
  hasResponseFormatDirective,
  injectResponseFormat,
  responseFormatBody,
  stripResponseFormat,
  type ResponseFormatTemplate,
} from "./response-format.js";

const ALL_TEMPLATES: ResponseFormatTemplate[] = [
  "default",
  "analysis",
  "progress",
  "publication",
  "batchPublication",
  "verification",
];

describe("response-format directive", () => {
  it("prepends the directive envelope to a plain prompt", () => {
    const out = injectResponseFormat("fais le café");
    expect(out.startsWith("<paseo-format>\n")).toBe(true);
    expect(out.endsWith("\n\nfais le café")).toBe(true);
    expect(hasResponseFormatDirective(out)).toBe(true);
  });

  it("is idempotent — never double-wraps", () => {
    const once = injectResponseFormat("hello");
    expect(injectResponseFormat(once)).toBe(once);
  });

  it("never double-wraps even when the template changes mid-conversation", () => {
    const once = injectResponseFormat("hello", "analysis");
    expect(injectResponseFormat(once, "progress")).toBe(once);
  });

  it("round-trips: strip returns the original text", () => {
    const original = "corrige le bug de synthèse";
    expect(stripResponseFormat(injectResponseFormat(original))).toBe(original);
  });

  it("strips the envelope of every template", () => {
    for (const template of ALL_TEMPLATES) {
      expect(stripResponseFormat(injectResponseFormat("prompt", template))).toBe("prompt");
    }
  });

  it("strips only the leading envelope, leaving a following brain block intact", () => {
    const inner = '<contexte_memoire source="cerveau" portee="projet">\nx\n</contexte_memoire>';
    const wrapped = injectResponseFormat(inner);
    expect(stripResponseFormat(wrapped)).toBe(inner);
  });

  it("strip is a no-op when the directive is absent", () => {
    expect(stripResponseFormat("no envelope here")).toBe("no envelope here");
    expect(hasResponseFormatDirective("no envelope here")).toBe(false);
  });
});

describe("response-format templates", () => {
  it("defaults to the five-section report", () => {
    const body = injectResponseFormat("x");
    expect(body).toContain("## 1. Ce qui est fait");
    expect(body).toContain("## 5. Activation & facturation");
  });

  it("analysis asks for the four analysis sections", () => {
    const body = responseFormatBody("analysis");
    expect(body).toContain("## 1. Objectif");
    expect(body).toContain("## 2. Approche retenue");
    expect(body).toContain("## 3. Fichiers & points de vigilance");
    expect(body).toContain("## 4. Estimation");
    expect(body).toContain("130 CHF/h");
    expect(body).toContain("quota");
  });

  it("analysis bans the report and billing sections outright", () => {
    const body = responseFormatBody("analysis");
    expect(body).not.toContain("## 1. Ce qui est fait");
    expect(body).not.toContain("## 4. Évolutions possibles");
    expect(body).not.toContain("## 5. Activation & facturation");
  });

  it("progress asks for the four report sections and one line per evolution", () => {
    const body = responseFormatBody("progress");
    expect(body).toContain("## 1. Ce qui est fait");
    expect(body).toContain("## 2. Ce qui change");
    expect(body).toContain("## 3. Impact");
    expect(body).toContain("## 4. Évolutions possibles");
    expect(body).toContain("UNE seule ligne");
    expect(body).not.toContain("## 5. Activation & facturation");
  });

  it("publication asks for the four publication sections only", () => {
    const body = responseFormatBody("publication");
    expect(body).toContain("## 1. Ce qui a été publié");
    expect(body).toContain("## 2. Déroulé de la publication");
    expect(body).toContain("## 3. Vérification");
    expect(body).toContain("## 4. Suites éventuelles");
    expect(body).not.toContain("## 1. Ce qui est fait");
    expect(body).not.toContain("Évolutions possibles");
    expect(body).not.toContain("facture");
  });

  it("batchPublication asks for the four grouped-publication sections only", () => {
    const body = responseFormatBody("batchPublication");
    expect(body).toContain("## 1. Tâches publiées");
    expect(body).toContain("## 2. Ce qui est en ligne");
    expect(body).toContain("## 3. Résultat de la publication");
    expect(body).toContain("## 4. État final");
    expect(body).toContain("PUBLICATION GROUPÉE");
    expect(body).not.toContain("## 1. Ce qui est fait");
    expect(body).not.toContain("Évolutions possibles");
    // "facture" (the billing section wording) — not "facturation", which the
    // exclusion line legitimately contains.
    expect(body).not.toContain("facture");
    expect(body).not.toContain("Estimation");
  });

  it("verification asks for the three check sections only", () => {
    const body = responseFormatBody("verification");
    expect(body).toContain("## 1. Ce qui a été vérifié");
    expect(body).toContain("## 2. Résultat du contrôle");
    expect(body).toContain("## 3. Ce que ça change");
    expect(body).toContain("CONTRÔLE FINAL");
    expect(body).not.toContain("## 1. Ce qui est fait");
    expect(body).not.toContain("Évolutions possibles");
    expect(body).not.toContain("Activation & facturation");
    expect(body).not.toContain("Estimation");
  });

  it("every template keeps the numbered `## N.` headings and the icon rule", () => {
    for (const template of ALL_TEMPLATES) {
      const body = responseFormatBody(template);
      expect(body).toContain("titres numérotés en Markdown `## N.`");
      expect(body).toContain("Les icônes des titres sont ajoutées automatiquement");
      expect(body).toContain("Lecteur non technique");
    }
  });
});
