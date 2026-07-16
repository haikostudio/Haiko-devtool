import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  BrainMemoryClient,
  formatRecall,
  injectBrainContext,
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
    const long = { texte: "x".repeat(5000) };
    expect(formatRecall([long]).length).toBeLessThanOrEqual(2000);
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

describe("BrainMemoryClient.recall", () => {
  it("returns the scoped results as portee=projet", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ resultats: [{ id: "1", texte: "souvenir projet" }] }),
    );
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.portee).toBe("projet");
    expect(result.count).toBe(1);
    expect(result.blob).toContain("souvenir projet");
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("/v1/memories/search");
  });

  it("falls back to the global scope when the project scope is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultats: [] })) // scoped → empty
      .mockResolvedValueOnce(jsonResponse({ resultats: [{ id: "9", texte: "global hit" }] }));
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    expect(result.portee).toBe("global");
    expect(result.blob).toContain("global hit");
  });

  it("does not fall back when globalFallback is disabled", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ resultats: [] }));
    const client = new BrainMemoryClient({
      logger,
      apiKey: "k",
      globalFallback: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.recall("q", { projet: "paseo" });
    // Only the scoped search + the overview attempt (which also returns empty).
    expect(result.count).toBe(0);
    expect(result.blob).toBe("");
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
