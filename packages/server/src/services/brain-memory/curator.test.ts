import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrainSouvenir } from "./client.js";
import { BrainCurator, briefToSouvenir } from "./curator.js";
import { ProjectBriefStore } from "./project-brief.js";

const logger = pino({ level: "silent" });

describe("BrainCurator", () => {
  let dir: string;
  let briefStore: ProjectBriefStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-curator-"));
    briefStore = new ProjectBriefStore(dir, logger);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function buildCurator(options: { finalText: string | Error }) {
    const runAgent = vi.fn(async () => {
      if (options.finalText instanceof Error) {
        throw options.finalText;
      }
      return { canceled: false, finalText: options.finalText, timeline: [] };
    });
    const createAgent = vi.fn(async () => ({
      snapshot: { id: "curator-agent-1" },
      initialPromptError: null,
    }));
    const note = vi.fn(async () => true);
    const curator = new BrainCurator({
      agentManager: { runAgent, archiveAgent: vi.fn(async () => {}) } as never,
      createAgent: createAgent as never,
      brain: { note } as never,
      briefStore,
      logger,
    });
    return { curator, runAgent, createAgent, note };
  }

  const memories: BrainSouvenir[] = [
    { id: "m1", texte: "Le sheet header doit garder topInset sur mobile." },
    { id: "m2", texte: "Message 'Oui clairement' échangé sur WhatsApp." },
    { id: "m3", texte: "La limite de dépense mensuelle a été atteinte." },
  ];

  describe("filterRecall (bibliothécaire)", () => {
    test("keeps only the memories the LLM selected, in order", async () => {
      const { curator } = buildCurator({ finalText: JSON.stringify({ garder: [0] }) });
      const kept = await curator.filterRecall({
        prompt: "Ajoute un bandeau en haut de l'app",
        memories,
        brief: null,
        projet: "Paseo",
        cwd: "/tmp/paseo",
      });
      expect(kept).toEqual([memories[0]]);
    });

    test("out-of-range and duplicate indices are dropped", async () => {
      const { curator } = buildCurator({
        finalText: JSON.stringify({ garder: [2, 2, 9, 0] }),
      });
      const kept = await curator.filterRecall({
        prompt: "Ajoute un bandeau en haut de l'app",
        memories,
        brief: null,
        projet: "Paseo",
        cwd: "/tmp/paseo",
      });
      expect(kept).toEqual([memories[0], memories[2]]);
    });

    test("empty candidate list short-circuits without spawning an agent", async () => {
      const { curator, createAgent } = buildCurator({ finalText: "unused" });
      const kept = await curator.filterRecall({
        prompt: "Ajoute un bandeau",
        memories: [],
        brief: null,
        projet: "Paseo",
        cwd: "/tmp/paseo",
      });
      expect(kept).toEqual([]);
      expect(createAgent).not.toHaveBeenCalled();
    });

    test("returns null when the internal agent fails (caller falls back)", async () => {
      const { curator } = buildCurator({ finalText: new Error("haiku exploded") });
      const kept = await curator.filterRecall({
        prompt: "Ajoute un bandeau en haut de l'app",
        memories,
        brief: null,
        projet: "Paseo",
        cwd: "/tmp/paseo",
      });
      expect(kept).toBeNull();
    });
  });

  describe("distillExchange (greffier)", () => {
    test("notes distilled facts and rewrites the fiche", async () => {
      const { curator, note } = buildCurator({
        finalText: JSON.stringify({
          souvenirs: ["Paseo : le bandeau d'app doit rester sous la barre de statut."],
          fiche: "# Paseo\n## Chantiers en cours\n- Bandeau en haut de l'app",
        }),
      });
      await curator.distillExchange({
        userText: "Ajoute un bandeau en haut de l'application",
        assistantText: "Fait — bandeau ajouté sous la barre de statut.",
        projet: "Paseo",
        cwd: "/tmp/paseo",
        discussionId: "agent-1",
      });
      expect(note).toHaveBeenCalledTimes(1);
      expect(note).toHaveBeenCalledWith(
        "Paseo : le bandeau d'app doit rester sous la barre de statut.",
        { source: "paseo-daemon", projet: "Paseo", discussionId: "agent-1" },
      );
      expect(await briefStore.load("Paseo")).toContain("Bandeau en haut de l'app");
    });

    test("nothing durable → no note, fiche untouched", async () => {
      await briefStore.save("Paseo", "fiche existante");
      const { curator, note } = buildCurator({
        finalText: JSON.stringify({ souvenirs: [], fiche: null }),
      });
      await curator.distillExchange({
        userText: "Explique-moi comment marche le recall",
        assistantText: "Voici comment ça marche…",
        projet: "Paseo",
        cwd: "/tmp/paseo",
        discussionId: "agent-1",
      });
      expect(note).not.toHaveBeenCalled();
      expect(await briefStore.load("Paseo")).toBe("fiche existante");
    });

    test("trivial exchange skips the LLM entirely", async () => {
      const { curator, createAgent, note } = buildCurator({ finalText: "unused" });
      await curator.distillExchange({
        userText: "dis OK",
        assistantText: "OK",
        projet: "Paseo",
        cwd: "/tmp/paseo",
        discussionId: "agent-1",
      });
      expect(createAgent).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalled();
    });

    test("low-substance prompt still distills when the answer is substantial", async () => {
      const { curator, createAgent } = buildCurator({
        finalText: JSON.stringify({ souvenirs: [], fiche: null }),
      });
      await curator.distillExchange({
        userText: "Oui",
        assistantText: "x".repeat(400),
        projet: "Paseo",
        cwd: "/tmp/paseo",
        discussionId: "agent-1",
      });
      expect(createAgent).toHaveBeenCalled();
    });

    test("agent failure is swallowed", async () => {
      const { curator, note } = buildCurator({ finalText: new Error("boom") });
      await expect(
        curator.distillExchange({
          userText: "Ajoute un bandeau en haut de l'application",
          assistantText: "Fait.",
          projet: "Paseo",
          cwd: "/tmp/paseo",
          discussionId: "agent-1",
        }),
      ).resolves.toBeUndefined();
      expect(note).not.toHaveBeenCalled();
    });
  });
});

describe("briefToSouvenir", () => {
  test("renders the fiche as a synthetic memory", () => {
    expect(briefToSouvenir("Paseo", "# Fiche").texte).toBe("📁 Fiche projet — Paseo\n# Fiche");
  });
});
