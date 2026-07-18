import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  BrainMemoryClient,
  formatRecall,
  injectBrainContext,
  parseBrainContextEnvelope,
  sameProject,
  selectPertinentSkills,
  skillToSouvenir,
  toTimelineMemories,
} from "./client.js";

const logger = pino({ level: "silent" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("formatRecall", () => {
  it("prefixes rejected leads with ⛔ and normal ones with a dash", () => {
    const blob = formatRecall([
      { texte: "un fait utile" },
      { texte: "une piste écartée", statut: "rejete", motif: "trop risqué" },
    ]);
    expect(blob).toContain("- un fait utile");
    expect(blob).toContain("⛔ (piste écartée — trop risqué) une piste écartée");
  });

  it("caps the blob length", () => {
    const long = { texte: "x".repeat(20_000) };
    expect(formatRecall([long]).length).toBeLessThanOrEqual(8_000);
  });
});

describe("injectBrainContext", () => {
  it("wraps the recall block and keeps the original text last", () => {
    const out = injectBrainContext("- souvenir", "projet", "ma question");
    expect(out).toContain('<contexte_memoire source="cerveau" portee="projet">');
    expect(out).toContain("- souvenir");
    expect(out.trimEnd().endsWith("ma question")).toBe(true);
    expect(out).toContain("n'appelle l'outil mémoire");
  });

  it("returns the text unchanged when the blob is empty", () => {
    expect(injectBrainContext("", "projet", "ma question")).toBe("ma question");
  });
});

describe("parseBrainContextEnvelope", () => {
  it("round-trips injectBrainContext back into user text + memories", () => {
    const blob = formatRecall([
      { texte: "un fait utile" },
      { texte: "une piste écartée", statut: "rejete", motif: "trop risqué" },
    ]);
    const injected = injectBrainContext(blob, "global", "vas'y relance le daemon");
    const parsed = parseBrainContextEnvelope(injected);
    expect(parsed).not.toBeNull();
    expect(parsed?.portee).toBe("global");
    expect(parsed?.userText).toBe("vas'y relance le daemon");
    expect(parsed?.memories).toEqual([
      { texte: "un fait utile" },
      { texte: "une piste écartée", rejete: true, motif: "trop risqué" },
    ]);
  });

  it("keeps multi-line memory texts attached to their entry", () => {
    const blob = formatRecall([{ texte: "ligne 1\nligne 2" }, { texte: "autre" }]);
    const injected = injectBrainContext(blob, "projet", "question");
    const parsed = parseBrainContextEnvelope(injected);
    expect(parsed?.memories).toEqual([{ texte: "ligne 1\nligne 2" }, { texte: "autre" }]);
  });

  it("preserves multi-line user text after the envelope", () => {
    const injected = injectBrainContext("- souvenir", "projet", "ligne A\n\nligne B");
    expect(parseBrainContextEnvelope(injected)?.userText).toBe("ligne A\n\nligne B");
  });

  it("parses a rejected lead without motif", () => {
    const blob = formatRecall([{ texte: "écartée", statut: "rejete" }]);
    const injected = injectBrainContext(blob, "projet", "q");
    expect(parseBrainContextEnvelope(injected)?.memories).toEqual([
      { texte: "écartée", rejete: true },
    ]);
  });

  it("returns null for plain user text and for user text mentioning the tag inline", () => {
    expect(parseBrainContextEnvelope("juste une question")).toBeNull();
    expect(parseBrainContextEnvelope("parle-moi de <contexte_memoire> stp")).toBeNull();
  });
});

describe("toTimelineMemories", () => {
  it("maps rejected status to a flag + motif", () => {
    const mapped = toTimelineMemories([
      { texte: "ok" },
      { texte: "no", statut: "rejete", motif: "car" },
      { texte: "   " },
    ]);
    expect(mapped).toEqual([{ texte: "ok" }, { texte: "no", rejete: true, motif: "car" }]);
  });
});

/**
 * Route the fetch mock by target: the scoped search (X-Cerveau-Project header),
 * the global search (no header) and the skills listing each get their own body.
 */
function brainFetchMock(bodies: {
  scoped?: unknown;
  global?: unknown;
  skills?: unknown;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: URL | string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/v1/skills")) {
      return jsonResponse(bodies.skills ?? []);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["X-Cerveau-Project"]) {
      return jsonResponse(bodies.scoped ?? { resultats: [] });
    }
    return jsonResponse(bodies.global ?? { resultats: [] });
  });
}

describe("sameProject", () => {
  it("matches display names against folder slugs (prod silo bug)", () => {
    // Mesuré en prod le 18/07/2026 : le démon scope par nom d'affichage, les
    // souvenirs sont tagués par slug — l'égalité stricte rendait le rappel vide.
    expect(sameProject("Paseo", "paseo")).toBe(true);
    expect(sameProject("Haiko Mail", "haikomail")).toBe(true);
    expect(sameProject("Haiko Formations", "formations")).toBe(true);
    expect(sameProject("Eloya", "eloya-saas")).toBe(true);
    expect(sameProject("La Roma", "la-roma")).toBe(true);
  });

  it("keeps namespaced and short keys strict", () => {
    expect(sameProject("Eloya", "eloya-user:3")).toBe(false);
    expect(sameProject("eloya-user:3", "eloya-user:3")).toBe(true);
    expect(sameProject("web", "webapp")).toBe(false);
    expect(sameProject("haikomail", "haiko-compta")).toBe(false);
  });
});

describe("BrainMemoryClient.recall", () => {
  it("keeps alias/family results from the scoped pass (Cerveau-resolved scope)", async () => {
    // Le Cerveau résout « Paseo » vers `paseo` (+ famille) : ces souvenirs sont
    // CEUX du projet — le garde anti-fuite ne doit plus les jeter.
    const fetchMock = brainFetchMock({
      scoped: {
        resultats: [
          { id: "1", texte: "fait du silo slug", project: "paseo" },
          { id: "2", texte: "fait d'un autre projet", project: "haikomail" },
        ],
      },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "Paseo" });
    expect(result.blob).toContain("fait du silo slug");
    expect(result.blob).not.toContain("autre projet");
    expect(result.portee).toBe("projet");
  });

  it("drops other-project-tagged memories from the global complement", async () => {
    // Mesuré en prod : un prompt vague (« mets à jour les docs ») ramenait par la
    // passe globale un souvenir 0.97 d'un projet SANS RAPPORT. Le complément ne
    // garde que le savoir global (non tagué) ou la même famille de projet.
    const fetchMock = brainFetchMock({
      scoped: { resultats: [{ id: "1", texte: "fait projet", project: "paseo" }] },
      global: {
        resultats: [
          { id: "2", texte: "docs d'un autre projet", score: 0.97, project: "haikomail" },
          { id: "3", texte: "convention globale", score: 0.5 },
          { id: "4", texte: "fait famille", score: 0.45, project: "Paseo" },
        ],
      },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.resultats.map((r) => r.id)).toEqual(["1", "3", "4"]);
  });

  it("returns the scoped results first as portee=projet", async () => {
    const fetchMock = brainFetchMock({
      scoped: { resultats: [{ id: "1", texte: "souvenir projet", project: "paseo" }] },
      global: { resultats: [{ id: "2", texte: "convention globale", score: 0.52 }] },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.portee).toBe("projet");
    expect(result.count).toBe(2);
    // Le projet d'abord, le complément global ensuite.
    expect(result.blob.indexOf("souvenir projet")).toBeLessThan(
      result.blob.indexOf("convention globale"),
    );
  });

  it("drops cross-project leaks from the scoped pass", async () => {
    // Le bug du 17/07/2026 : scopé Maroket, le chemin lexical du Cerveau ramenait
    // des souvenirs whatsapp-perso/bluemangocloud. Un vieux Cerveau non corrigé ne
    // doit jamais les faire passer dans le prompt.
    const fetchMock = brainFetchMock({
      scoped: {
        resultats: [
          { id: "1", texte: "message à Michael", project: "whatsapp-perso" },
          { id: "2", texte: "fait du projet", project: "Maroket" },
          { id: "3", texte: "fait sans projet" },
        ],
      },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "maroket" });
    expect(result.blob).not.toContain("Michael");
    expect(result.blob).toContain("fait du projet");
    expect(result.blob).toContain("fait sans projet");
  });

  it("dedupes the global complement against the scoped results and caps at k", async () => {
    const fetchMock = brainFetchMock({
      scoped: {
        resultats: [
          { id: "1", texte: "a", project: "paseo" },
          { id: "2", texte: "b", project: "paseo" },
        ],
      },
      global: {
        resultats: [
          { id: "2", texte: "b", score: 0.6 },
          { id: "3", texte: "c", score: 0.5 },
          { id: "4", texte: "d", score: 0.5 },
        ],
      },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo", k: 3 });
    expect(result.resultats.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("drops weak and lexical-concept matches from the global complement", async () => {
    // Observé en prod (requête du 17/07/2026) : la passe globale ramenait un
    // garde-fou exempté (0.0004), un repêchage (0.02) et deux souvenirs d'un
    // autre projet via le concept « test » (0.6). Aucun ne doit compléter.
    const fetchMock = brainFetchMock({
      global: {
        resultats: [
          { id: "1", texte: "garde-fou Playwright", statut: "rejete", score: 0.0004 },
          { id: "2", texte: "repêchage instance dev", score: 0.0217, via: "repechage" },
          { id: "3", texte: "test Brevo template 9", score: 0.5999, via: "concept:test" },
          { id: "4", texte: "convention solide", score: 0.47, via: "secret+generique+fait" },
        ],
      },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "maroket" });
    expect(result.resultats.map((r) => r.id)).toEqual(["4"]);
  });

  it("is portee=global when the project scope is empty", async () => {
    const fetchMock = brainFetchMock({
      global: { resultats: [{ id: "9", texte: "global hit", score: 0.47 }] },
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.portee).toBe("global");
    expect(result.blob).toContain("global hit");
  });

  it("skips the global search when globalFallback is disabled", async () => {
    const fetchMock = brainFetchMock({});
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      globalFallback: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.count).toBe(0);
    expect(result.blob).toBe("");
    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/v1/memories/search"),
    );
    expect(searchCalls).toHaveLength(1);
  });

  it("a full miss injects nothing — no broad overview searches", async () => {
    const fetchMock = brainFetchMock({});
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("question technique sans souvenir", { projet: "paseo" });
    expect(result.count).toBe(0);
    expect(result.blob).toBe("");
    // Scoped + global + skills only — never the old "aperçu" fan-out.
    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/v1/memories/search"),
    );
    expect(searchCalls).toHaveLength(2);
  });

  it("appends the pertinent skill as a bounded procedure line", async () => {
    const fetchMock = brainFetchMock({
      skills: [
        {
          id: "s1",
          name: "deploy-maroket",
          description: "Comment déployer Maroket en production",
          procedure: "1. push sur main\n2. attendre la CI",
          portee: "projet",
          project: "maroket",
        },
        {
          id: "s2",
          name: "convention-commits",
          description: "Format des messages de commit",
          procedure: "…",
          portee: "global",
        },
      ],
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("qu'est-ce que tu entends par déployer ?", {
      projet: "maroket",
    });
    expect(result.blob).toContain("📋 Procédure « deploy-maroket »");
    expect(result.blob).toContain("push sur main");
    // La skill globale sans rapport avec la demande n'est pas injectée.
    expect(result.blob).not.toContain("convention-commits");
    const skillCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/v1/skills"));
    expect(skillCall).toBeDefined();
    expect(String(skillCall?.[0])).toContain("statut=actif");
  });

  it("is best-effort: a throwing fetch yields empty context", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.count).toBe(0);
    expect(result.blob).toBe("");
  });
});

describe("selectPertinentSkills", () => {
  const deploy = {
    id: "s1",
    name: "deploy-eloya",
    description: "Procédure de déploiement des releases",
    portee: "projet",
    project: "eloya",
  };
  const commits = {
    id: "s2",
    name: "convention-commits",
    description: "Format des messages de commit",
    portee: "global",
  };

  it("keeps only the skills sharing a word with the prompt", () => {
    const picked = selectPertinentSkills([deploy, commits], "comment déployer la release ?");
    expect(picked.map((s) => s.id)).toEqual(["s1"]);
  });

  it("ranks the project's own skills first", () => {
    const globalDeploy = { ...commits, id: "s3", description: "Checklist de déploiement" };
    const picked = selectPertinentSkills([globalDeploy, deploy], "on déploie ?", "eloya");
    expect(picked[0]?.id).toBe("s1");
  });

  it("returns nothing for a prompt without meaningful words", () => {
    expect(selectPertinentSkills([deploy], "ok")).toEqual([]);
  });
});

describe("skillToSouvenir", () => {
  it("bounds long procedures", () => {
    const out = skillToSouvenir({
      id: "s",
      name: "longue",
      description: "d",
      procedure: "x".repeat(2000),
    });
    expect((out.texte ?? "").length).toBeLessThan(700 + 64);
    expect(out.texte).toContain("…");
  });
});

describe("BrainMemoryClient.note", () => {
  it("posts the exchange and scopes it to the project", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ garde: true }));
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const ok = await client.note("un échange", { source: "paseo-daemon", projet: "paseo" });
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "POST" });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Cerveau-Project"]).toBe("paseo");
  });

  it("swallows errors and returns false", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.note("x", { source: "paseo-daemon" })).toBe(false);
  });

  it("skips empty notes without calling fetch", async () => {
    const fetchMock = vi.fn();
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.note("   ", { source: "paseo-daemon" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
