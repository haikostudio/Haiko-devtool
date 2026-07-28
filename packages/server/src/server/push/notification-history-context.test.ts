import { describe, expect, it } from "vitest";

import { clampToSentences, normalizePushHistoryContext } from "./notification-history-context.js";

describe("clampToSentences", () => {
  it("keeps a short summary untouched", () => {
    expect(clampToSentences("Le build est vert.")).toBe("Le build est vert.");
  });

  it("keeps at most three sentences", () => {
    const text = "Un. Deux. Trois. Quatre. Cinq.";
    expect(clampToSentences(text)).toBe("Un. Deux. Trois.");
  });

  it("cuts on sentence boundaries, never mid-word", () => {
    const text = "J'ai corrigé le bug ! Les tests passent ? Oui… Et j'ai poussé la branche.";
    expect(clampToSentences(text)).toBe("J'ai corrigé le bug ! Les tests passent ? Oui…");
  });

  it("respects an explicit sentence budget", () => {
    expect(clampToSentences("Un. Deux. Trois.", 1)).toBe("Un.");
  });

  it("collapses newlines and repeated spaces", () => {
    expect(clampToSentences("Ligne une.\n\n  Ligne deux.")).toBe("Ligne une. Ligne deux.");
  });

  it("returns a lone unpunctuated sentence as-is", () => {
    expect(clampToSentences("travail en cours sans ponctuation")).toBe(
      "travail en cours sans ponctuation",
    );
  });

  it("returns null when there is nothing usable", () => {
    expect(clampToSentences(null)).toBeNull();
    expect(clampToSentences(undefined)).toBeNull();
    expect(clampToSentences("   ")).toBeNull();
  });
});

describe("normalizePushHistoryContext", () => {
  it("drops blank and missing fields", () => {
    expect(
      normalizePushHistoryContext({
        taskTitle: "Refondre les notifications",
        projectName: "   ",
        summary: null,
        agentId: "agent-1",
      }),
    ).toEqual({ taskTitle: "Refondre les notifications", agentId: "agent-1" });
  });

  it("returns an empty object when there is no context", () => {
    expect(normalizePushHistoryContext(undefined)).toEqual({});
  });
});
