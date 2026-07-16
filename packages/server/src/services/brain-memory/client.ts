import type { Logger } from "pino";

/**
 * REST client for the external "Cerveau" long-term memory service
 * (https://memoire.haiko-s1.com). The Cerveau is NOT an MCP stdio server: it is
 * a keyed REST API. The daemon calls it around each user prompt — *recall*
 * before, *note* after — so the agent receives already-chewed context and does
 * not have to spend quota round-tripping the memory MCP tool itself.
 *
 * Ported from the production-proven `/root/eloya-vps/src/eloya/brain.py`.
 *
 * Everything is best-effort: a Cerveau outage must NEVER break a chat turn.
 * `recall` returns empty context, `note` swallows the error.
 *
 * Endpoints:
 *   GET  /v1/memories/search?q=&k=                → recall (SouvenirOut[])
 *   POST /v1/memories {texte, source, projet?, discussion_id?}  → note
 * Auth: `Authorization: Bearer <key>`, scope via `X-Cerveau-Project`.
 */

export type BrainFetch = typeof fetch;

export const DEFAULT_BRAIN_BASE_URL = "https://memoire.haiko-s1.com";

// 10 s: a NON-scoped search (global fallback) goes through the Cerveau's broad
// gather + rerank — ~1 s warm but >4 s cold (observed in prod, everything went
// to ReadTimeout and came back empty).
const RECALL_TIMEOUT_MS = 10_000;
const NOTE_TIMEOUT_MS = 6_000;
const MAX_BLOB_CHARS = 2_000;
const MAX_NOTE_CHARS = 4_000;

/** One memory as returned by the Cerveau search endpoint (subset we use). */
export interface BrainSouvenir {
  id?: string;
  texte?: string;
  statut?: string;
  motif?: string;
  score?: number;
}

export type BrainPortee = "projet" | "global" | "apercu";

export interface BrainRecallResult {
  /** Compact block ready to inject into the prompt. Empty if nothing recalled. */
  blob: string;
  count: number;
  portee: BrainPortee;
  resultats: BrainSouvenir[];
}

export interface BrainMemoryClientOptions {
  logger: Logger;
  apiKey: string;
  baseUrl?: string;
  fetch?: BrainFetch;
  /** Allow falling back to the whole (unscoped) brain when the project scope is empty. */
  globalFallback?: boolean;
}

// Broad queries covering the main axes of a personal memory — the Cerveau's
// global map (/v1/carte) is NOT project-scoped, so the "summary of my memory"
// overview is built here: several broad scoped searches, aggregated + deduped.
const OVERVIEW_QUERIES = [
  "profil de l'utilisateur, qui il est, informations personnelles",
  "préférences, goûts, habitudes",
  "projets en cours, objectifs",
  "travail, activité professionnelle",
  "événements récents, décisions prises",
] as const;

export class BrainMemoryClient {
  private readonly logger: Logger;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: BrainFetch;
  private readonly globalFallback: boolean;

  constructor(options: BrainMemoryClientOptions) {
    this.logger = options.logger.child({ module: "brain-memory" });
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BRAIN_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.globalFallback = options.globalFallback ?? true;
  }

  private headers(options?: { projet?: string; session?: string }): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Cerveau-Client": "paseo-daemon",
    };
    if (options?.session) {
      headers["X-Cerveau-Session"] = options.session;
    }
    if (options?.projet) {
      headers["X-Cerveau-Project"] = options.projet;
    }
    return headers;
  }

  /**
   * Raw search against the Cerveau → list of memories. Empty list on nothing or
   * error (best-effort). Each memory: `texte`, `statut` (`rejete` = discarded
   * lead), `motif`, `score`…
   */
  async search(
    query: string,
    options?: { k?: number; projet?: string; session?: string },
  ): Promise<BrainSouvenir[]> {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return [];
    }
    const k = Math.max(1, Math.min(options?.k ?? 5, 20));
    const url = new URL(`${this.baseUrl}/v1/memories/search`);
    url.searchParams.set("q", trimmed.slice(0, 500));
    url.searchParams.set("k", String(k));
    try {
      const resp = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ projet: options?.projet, session: options?.session }),
        signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
      });
      if (!resp.ok) {
        this.logger.debug({ status: resp.status }, "cerveau: search non-ok");
        return [];
      }
      const data = (await resp.json()) as { resultats?: BrainSouvenir[] };
      return data.resultats ?? [];
    } catch (err) {
      this.logger.debug({ err }, "cerveau: search failed");
      return [];
    }
  }

  /**
   * Broad overview of the scoped memory: aggregates several wide searches.
   * Deduped by id. Empty list if the memory is empty or on error.
   */
  private async overview(options?: {
    projet?: string;
    perQuery?: number;
    includeGlobal?: boolean;
  }): Promise<BrainSouvenir[]> {
    const perQuery = options?.perQuery ?? 4;
    const scopes: (string | undefined)[] = [options?.projet];
    if (options?.includeGlobal && options?.projet) {
      scopes.push(undefined); // global after the scope → client's memories first
    }
    const jobs: { q: string; projet: string | undefined }[] = [];
    for (const projet of scopes) {
      for (const q of OVERVIEW_QUERIES) {
        jobs.push({ q, projet });
      }
    }
    // Bounded concurrency: too many parallel searches bring the Cerveau's rerank
    // to its knees (everything then times out). 3 at a time stays well under.
    const batches = await runWithConcurrency(
      jobs,
      3,
      (job) => this.search(job.q, { k: perQuery, projet: job.projet }),
      this.logger,
    );
    const seen = new Set<string>();
    const out: BrainSouvenir[] = [];
    for (const batch of batches) {
      for (const s of batch) {
        const sid = s.id ?? (s.texte ?? "").slice(0, 80);
        if (seen.has(sid)) {
          continue;
        }
        seen.add(sid);
        out.push(s);
      }
    }
    return out;
  }

  /**
   * Recall relevant memories — ALWAYS returns context if the memory is not empty.
   * Three progressive tiers (like a person: precise memory → broader → general
   * knowledge): scoped search → global fallback if empty → overview if nothing
   * matched semantically (meta questions like "summarize your memory").
   */
  async recall(
    query: string,
    options?: { k?: number; projet?: string; session?: string },
  ): Promise<BrainRecallResult> {
    const k = options?.k ?? 5;
    let resultats = await this.search(query, {
      k,
      projet: options?.projet,
      session: options?.session,
    });
    let portee: BrainPortee = "projet";
    if (resultats.length === 0 && this.globalFallback && options?.projet) {
      resultats = await this.search(query, { k, projet: undefined, session: options?.session });
      if (resultats.length > 0) {
        portee = "global";
      }
    }
    if (resultats.length === 0) {
      const overview = await this.overview({
        projet: options?.projet,
        perQuery: 4,
        includeGlobal: this.globalFallback,
      });
      resultats = overview.slice(0, Math.max(k, 8));
      if (resultats.length > 0) {
        portee = "apercu";
      }
    }
    return {
      blob: formatRecall(resultats),
      count: resultats.length,
      portee,
      resultats,
    };
  }

  /**
   * Note an exchange into the Cerveau (best-effort, never throws). The Cerveau
   * marks the note `pending_synthesis` — it is NOT immediately searchable.
   */
  async note(
    texte: string,
    options: { source: string; projet?: string; discussionId?: string },
  ): Promise<boolean> {
    const trimmed = (texte ?? "").trim();
    if (!trimmed) {
      return false;
    }
    const body: Record<string, string> = {
      texte: trimmed.slice(0, MAX_NOTE_CHARS),
      source: options.source,
    };
    if (options.discussionId) {
      body.discussion_id = options.discussionId;
    }
    if (options.projet) {
      body.projet = options.projet;
    }
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/v1/memories`, {
        method: "POST",
        headers: {
          ...this.headers({ projet: options.projet, session: options.discussionId }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(NOTE_TIMEOUT_MS),
      });
      return resp.ok;
    } catch (err) {
      this.logger.debug({ err }, "cerveau: note failed");
      return false;
    }
  }
}

/** Compact block of memories ready to inject into a prompt (≤ MAX_BLOB_CHARS). */
export function formatRecall(resultats: BrainSouvenir[]): string {
  const lines: string[] = [];
  for (const s of resultats) {
    const texte = (s.texte ?? "").trim();
    if (!texte) {
      continue;
    }
    if (s.statut === "rejete") {
      const motif = (s.motif ?? "").trim();
      const prefix = `⛔ (piste écartée${motif ? ` — ${motif}` : ""}) `;
      lines.push(`${prefix}${texte}`);
    } else {
      lines.push(`- ${texte}`);
    }
  }
  return lines.join("\n").slice(0, MAX_BLOB_CHARS);
}

/**
 * Prepend the recalled memory block to the user's text as a delimited context
 * section. The closing hint explicitly discourages the agent from re-calling the
 * memory MCP tool — that is the whole point of pre-recalling server-side.
 */
export function injectBrainContext(blob: string, portee: BrainPortee, userText: string): string {
  if (!blob.trim()) {
    return userText;
  }
  return [
    `<contexte_memoire source="cerveau" portee="${portee}">`,
    blob,
    "</contexte_memoire>",
    "Note: cette mémoire pertinente est déjà rappelée ci-dessus ; n'appelle l'outil mémoire que s'il te faut davantage.",
    "",
    userText,
  ].join("\n");
}

/** Convert a memory list into the wire shape for the brain_context timeline item. */
export function toTimelineMemories(
  resultats: BrainSouvenir[],
): { texte: string; rejete?: boolean; motif?: string }[] {
  const out: { texte: string; rejete?: boolean; motif?: string }[] = [];
  for (const s of resultats) {
    const texte = (s.texte ?? "").trim();
    if (!texte) {
      continue;
    }
    if (s.statut === "rejete") {
      out.push({ texte, rejete: true, motif: (s.motif ?? "").trim() || undefined });
    } else {
      out.push({ texte });
    }
  }
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  logger: Logger,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index]);
      } catch (err) {
        logger.debug({ err }, "cerveau: overview sub-search failed");
        results[index] = [] as unknown as R;
      }
    }
  }
  const pumps = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => pump());
  await Promise.all(pumps);
  return results;
}
