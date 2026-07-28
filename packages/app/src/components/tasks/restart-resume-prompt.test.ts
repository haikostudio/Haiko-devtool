import { describe, expect, it } from "vitest";
import { buildRestartResumePrompt } from "./restart-resume-prompt";

describe("buildRestartResumePrompt", () => {
  it("names the objective the agent was working on", () => {
    const prompt = buildRestartResumePrompt({
      agentId: "a1",
      objective: "Corriger l'alignement du bandeau",
    });
    expect(prompt).toContain("Corriger l'alignement du bandeau");
  });

  it("always warns against redoing finished work", () => {
    // This is the whole reason the resume is not a replay of the original
    // prompt: an agent that had already committed would commit twice.
    const prompt = buildRestartResumePrompt({ agentId: "a1", objective: "Publier le site" });
    expect(prompt).toContain("DÉJÀ");
    expect(prompt).toContain("redémarré");
  });

  it("falls back to re-reading the thread when no objective is known", () => {
    const prompt = buildRestartResumePrompt({ agentId: "a1", objective: null });
    expect(prompt).toContain("Relis le fil");
    expect(prompt).not.toContain("« »");
  });

  it("treats a blank objective as no objective", () => {
    const prompt = buildRestartResumePrompt({ agentId: "a1", objective: "   " });
    expect(prompt).toContain("Relis le fil");
  });
});
