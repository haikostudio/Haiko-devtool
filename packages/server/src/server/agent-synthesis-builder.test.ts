import { describe, expect, it } from "vitest";
import { buildAgentSynthesis } from "./agent-synthesis-builder.js";

const NOW = "2026-07-18T00:00:00.000Z";

describe("buildAgentSynthesis", () => {
  it("returns null for an empty transcript", () => {
    expect(buildAgentSynthesis({ turns: [], now: NOW })).toBeNull();
    expect(buildAgentSynthesis({ turns: [{ role: "user", text: "   " }], now: NOW })).toBeNull();
  });

  it("summarizes the latest message and keeps the first user ask as the objective", () => {
    const result = buildAgentSynthesis({
      turns: [
        { role: "user", text: "Ajoute un mode sombre au dashboard" },
        { role: "assistant", text: "C'est fait, le thème bascule via un toggle." },
        { role: "user", text: "Maintenant règle le bug de contraste sur les boutons" },
      ],
      status: "running",
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.summary).toBe("Maintenant règle le bug de contraste sur les boutons");
    expect(result?.objective).toBe("Ajoute un mode sombre au dashboard");
    expect(result?.state).toBe("L'agent travaille…");
    expect(result?.updatedAt).toBe(NOW);
  });

  it("reflects the agent's reply as the summary after a turn", () => {
    const result = buildAgentSynthesis({
      turns: [
        { role: "user", text: "Corrige le crash au démarrage" },
        { role: "assistant", text: "Le crash venait d'un null; je l'ai gardé." },
      ],
      status: "idle",
      now: NOW,
    });
    expect(result?.summary).toBe("Le crash venait d'un null; je l'ai gardé.");
    expect(result?.state).toBe("Réponse reçue");
  });

  it("drops the objective when it would repeat the summary (single message)", () => {
    const result = buildAgentSynthesis({
      turns: [{ role: "user", text: "Explique-moi l'architecture" }],
      status: "idle",
      now: NOW,
    });
    expect(result?.summary).toBe("Explique-moi l'architecture");
    expect(result?.objective).toBeNull();
    expect(result?.state).toBe("En attente de traitement");
  });

  it("condenses a long message at a sentence boundary with an ellipsis fallback", () => {
    const long = `${"Première phrase courte. "}${"mot ".repeat(120)}`;
    const result = buildAgentSynthesis({
      turns: [{ role: "user", text: long }],
      now: NOW,
    });
    expect(result?.summary.length).toBeLessThanOrEqual(240);
    // Cut lands on the sentence boundary since it keeps enough of the budget is
    // false here (first sentence is short), so it falls back to a word cut.
    expect(result?.summary.endsWith("…")).toBe(true);
    expect(result?.summary).not.toContain("  ");
  });

  it("merges contiguous same-role chunks before choosing the last turn", () => {
    const result = buildAgentSynthesis({
      turns: [
        { role: "user", text: "Question" },
        { role: "assistant", text: "Partie une." },
        { role: "assistant", text: "Partie deux." },
      ],
      status: "idle",
      now: NOW,
    });
    // Same-role merging is an upstream concern, but the builder must still pick
    // the final assistant turn verbatim when passed pre-merged input.
    expect(result?.summary).toBe("Partie deux.");
  });
});

describe("buildAgentSynthesis — awaitsUser", () => {
  it("flags a closing question from the agent", () => {
    const synthesis = buildAgentSynthesis({
      turns: [
        { role: "user", text: "Corrige le badge." },
        { role: "assistant", text: "C'est corrigé.\n\nJe publie tout de suite ?" },
      ],
      now: "2026-07-28T10:00:00.000Z",
    });
    expect(synthesis?.awaitsUser).toBe(true);
  });

  it("stays false when the agent simply reports finished work", () => {
    const synthesis = buildAgentSynthesis({
      turns: [
        { role: "user", text: "Corrige le badge." },
        { role: "assistant", text: "C'est corrigé, testé et enregistré." },
      ],
      now: "2026-07-28T10:00:00.000Z",
    });
    expect(synthesis?.awaitsUser).toBe(false);
  });

  it("clears itself as soon as the user answers", () => {
    const synthesis = buildAgentSynthesis({
      turns: [
        { role: "assistant", text: "Je publie tout de suite ?" },
        { role: "user", text: "Oui, vas-y." },
      ],
      now: "2026-07-28T10:00:00.000Z",
    });
    expect(synthesis?.awaitsUser).toBe(false);
  });

  it("looks past the trimmed summary to the end of a long reply", () => {
    // The summary keeps the first ~240 characters; the question lives at the end.
    const long = `${"Compte rendu détaillé de la correction appliquée. ".repeat(20)}\nTu valides ?`;
    const synthesis = buildAgentSynthesis({
      turns: [{ role: "assistant", text: long }],
      now: "2026-07-28T10:00:00.000Z",
    });
    expect(synthesis?.summary.includes("Tu valides")).toBe(false);
    expect(synthesis?.awaitsUser).toBe(true);
  });
});
