import { describe, expect, it } from "vitest";
import { parseTaskAnalysisEstimateBlock } from "./task-analysis-estimate";

const FULL = {
  tokens: 190000,
  quotaPercent: 12,
  estimatedMinutes: 12,
  confidence: "medium",
  summary: "Petite tâche d'affichage.",
  billingTitle: "Affichage analyse tâche",
  billingDescription: "Rendu propre du résultat d'analyse.",
  billingHours: 3.5,
};

describe("parseTaskAnalysisEstimateBlock", () => {
  it("parses a complete estimate block", () => {
    const parsed = parseTaskAnalysisEstimateBlock(JSON.stringify(FULL));
    expect(parsed).not.toBeNull();
    expect(parsed?.tokens).toBe(190000);
    expect(parsed?.confidence).toBe("medium");
    expect(parsed?.billingHours).toBe(3.5);
  });

  it("parses an estimate without the optional billing fields", () => {
    const core = {
      tokens: FULL.tokens,
      quotaPercent: FULL.quotaPercent,
      estimatedMinutes: FULL.estimatedMinutes,
      confidence: FULL.confidence,
      summary: FULL.summary,
    };
    const parsed = parseTaskAnalysisEstimateBlock(JSON.stringify(core));
    expect(parsed).not.toBeNull();
    expect(parsed?.billingHours).toBeUndefined();
  });

  it("tolerates surrounding whitespace", () => {
    const parsed = parseTaskAnalysisEstimateBlock(`\n  ${JSON.stringify(FULL)}\n`);
    expect(parsed).not.toBeNull();
  });

  it("returns null for an unrelated JSON block", () => {
    expect(parseTaskAnalysisEstimateBlock('{"foo": 1, "bar": 2}')).toBeNull();
  });

  it("returns null for a non-JSON code block", () => {
    expect(parseTaskAnalysisEstimateBlock("const x = 1;")).toBeNull();
  });

  it("returns null for partial (mid-stream) JSON", () => {
    expect(parseTaskAnalysisEstimateBlock('{"tokens": 100, "quotaPercent": 5')).toBeNull();
  });

  it("returns null when a core field is missing", () => {
    const withoutMinutes = {
      tokens: FULL.tokens,
      quotaPercent: FULL.quotaPercent,
      confidence: FULL.confidence,
      summary: FULL.summary,
    };
    expect(parseTaskAnalysisEstimateBlock(JSON.stringify(withoutMinutes))).toBeNull();
  });

  it("returns null when confidence is not a known level", () => {
    expect(
      parseTaskAnalysisEstimateBlock(JSON.stringify({ ...FULL, confidence: "sure" })),
    ).toBeNull();
  });
});
