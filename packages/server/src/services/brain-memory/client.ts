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
// Leaves room for the project fiche (first prompt, ≤6000 chars) plus filtered
// memories and a couple of recalled procedures. Follow-up recalls carry no
// fiche and a librarian-filtered list, so they stay far below the cap.
const MAX_BLOB_CHARS = 8_000;
const MAX_NOTE_CHARS = 4_000;
const MAX_SKILLS_INJECTED = 2;
const MAX_SKILL_PROCEDURE_CHARS = 600;
// The Cerveau's own "anchored recall" relevance floor. The unscoped complement
// pass reuses it client-side: below it live the repêchage (≥0.02) and
// exempted-guardrail results that only make sense inside a project scope.
const GLOBAL_COMPLEMENT_MIN_SCORE = 0.3;

/** One memory as returned by the Cerveau search endpoint (subset we use). */
export interface BrainSouvenir {
  id?: string;
  texte?: string;
  statut?: string;
  motif?: string;
  score?: number;
  /** Project the memory belongs to — used to drop cross-project leaks client-side. */
  project?: string | null;
  /** Recall path that surfaced the memory ("concept:mot", "repechage", layers…). */
  via?: string | null;
  /** ISO date the memory was last confirmed — the closest thing to an "age". */
  date_derniere_confirmation?: string | null;
}

/** One stored procedure ("skill") as returned by GET /v1/skills (subset we use). */
export interface BrainSkill {
  id?: string;
  name?: string;
  description?: string;
  procedure?: string;
  portee?: string;
  project?: string | null;
  sujets?: string[];
}

// "apercu" is no longer emitted (the overview tier injected unrelated noise on
// every recall miss) but stays in the wire enum: persisted timeline items may
// still carry it.
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
    options?: { k?: number; projet?: string; session?: string; contexteConversation?: string },
  ): Promise<BrainSouvenir[]> {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return [];
    }
    const k = Math.max(1, Math.min(options?.k ?? 5, 20));
    const url = new URL(`${this.baseUrl}/v1/memories/search`);
    url.searchParams.set("q", trimmed.slice(0, 500));
    url.searchParams.set("k", String(k));
    // Short excerpt of the ongoing conversation: the Cerveau uses it to enrich
    // the embedding AND to disambiguate polysemous prompt words ("espace" in a
    // design conversation = layout spacing, not the whitespace character).
    const ctx = (options?.contexteConversation ?? "").trim();
    if (ctx) {
      url.searchParams.set("contexte_conversation", ctx.slice(0, 500));
    }
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
   * List the active skills (stored procedures) relevant to the current task.
   * The new Cerveau filters server-side on `q` + the project header; an older
   * Cerveau ignores the unknown `q` param and returns every active skill —
   * either way `selectPertinentSkills` re-filters client-side. Empty on error.
   */
  async listSkills(
    query: string,
    options?: { projet?: string; session?: string },
  ): Promise<BrainSkill[]> {
    const url = new URL(`${this.baseUrl}/v1/skills`);
    url.searchParams.set("statut", "actif");
    const trimmed = (query ?? "").trim();
    if (trimmed) {
      url.searchParams.set("q", trimmed.slice(0, 500));
    }
    try {
      const resp = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ projet: options?.projet, session: options?.session }),
        signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
      });
      if (!resp.ok) {
        this.logger.debug({ status: resp.status }, "cerveau: skills non-ok");
        return [];
      }
      const data = (await resp.json()) as BrainSkill[];
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.debug({ err }, "cerveau: skills failed");
      return [];
    }
  }

  /**
   * Recall relevant memories for a prompt. Project first: the scoped search
   * anchors the recall, a parallel global search fills the remaining slots
   * (deploy conventions, guardrails… live outside any one project), and the
   * relevant stored procedures (skills) are appended so "je parle de déployer"
   * surfaces the deployment process, not just loose facts. Cross-project
   * results leaking out of the scoped pass are dropped client-side (older
   * Cerveau versions leaked through the lexical concept path). A miss stays a
   * miss — no broad "overview" injection on unrelated prompts.
   */
  async recall(
    query: string,
    options?: { k?: number; projet?: string; session?: string; contexteConversation?: string },
  ): Promise<BrainRecallResult> {
    const k = options?.k ?? 5;
    const projet = options?.projet;
    const session = options?.session;
    const contexteConversation = options?.contexteConversation;
    const [scopedRaw, globalRaw, skillsRaw] = await Promise.all([
      projet
        ? this.search(query, { k, projet, session, contexteConversation })
        : Promise.resolve([]),
      !projet || this.globalFallback
        ? this.search(query, { k, session, contexteConversation })
        : Promise.resolve<BrainSouvenir[]>([]),
      this.listSkills(query, { projet, session }),
    ]);
    // Leak guard: a scoped search must only return the project's own memories
    // (or unscoped ones); anything tagged with another project is a Cerveau
    // recall bug bleeding through — never inject it. Family-tolerant: the
    // Cerveau resolves the scope to aliases ("Paseo" covers `paseo`, "Eloya"
    // covers `eloya-saas`) — those are the project's own memories, keep them.
    const scoped = scopedRaw.filter((s) => !s.project || !projet || sameProject(s.project, projet));
    // The unscoped complement only keeps solidly relevant matches: repêchage
    // (score ≥0.02) and exempted guardrails only make sense inside a project
    // scope, and lexical concept matches are cross-project by construction —
    // a generic dev word ("test") would drag another project's facts into the
    // conversation. Inside the project scope all of these stay welcome.
    // And when a scope is set, the complement's job is GLOBAL knowledge
    // (deploy conventions, guardrails): a memory tagged with a DIFFERENT
    // project is another project's context by definition — measured in prod, a
    // vague "update the docs" prompt dragged a 0.97-scored memory from an
    // unrelated project. Untagged or same-family memories stay welcome.
    const complement = globalRaw.filter(
      (s) =>
        (s.score ?? 0) >= GLOBAL_COMPLEMENT_MIN_SCORE &&
        !s.via?.startsWith("concept:") &&
        (!projet || !s.project || sameProject(s.project, projet)),
    );
    const seen = new Set(scoped.map((s) => s.id).filter(Boolean));
    const resultats = [...scoped];
    for (const s of complement) {
      if (resultats.length >= k) {
        break;
      }
      if (s.id && seen.has(s.id)) {
        continue;
      }
      if (s.id) {
        seen.add(s.id);
      }
      resultats.push(s);
    }
    const skills = selectPertinentSkills(skillsRaw, query, projet);
    resultats.push(...skills.map(skillToSouvenir));
    const portee: BrainPortee = scoped.length > 0 ? "projet" : "global";
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

/** Fold accents + case so "Maroket" ≈ "maroket" and "sécurité" ≈ "securite". */
export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Compact project key, mirror of the Cerveau's `projets.cle`: accents folded,
 * lowercase, only alphanumerics (and the `:` namespace marker) survive.
 * "Haiko Mail" → "haikomail", "eloya-user:3" → "eloyauser:3".
 */
export function projectKey(text: string): string {
  return foldText(text).replace(/[^a-z0-9:]+/g, "");
}

// Below this length a compact key is too generic to justify a family match
// ("web" must not swallow "webapp"). Mirror of the Cerveau's `_MIN_FAMILLE`.
const MIN_FAMILY_KEY = 5;

/**
 * Same project, alias/family tolerant — mirror of the Cerveau's server-side
 * scope resolution (`projets.meme_projet`). Exact compact key = alias ("Paseo"
 * ≈ "paseo", "Haiko Mail" ≈ "haikomail"); prefix/suffix = same family ("Eloya"
 * ≈ "eloya-saas", "Haiko Formations" ≈ "formations"). Namespaced tags (`:`,
 * e.g. per-end-user silos like "eloya-user:3") never family-match, and short
 * keys require exact equality.
 */
export function sameProject(a?: string | null, b?: string | null): boolean {
  const ka = projectKey(a ?? "");
  const kb = projectKey(b ?? "");
  if (!ka || !kb) {
    return false;
  }
  if (ka === kb) {
    return true;
  }
  if (ka.includes(":") || kb.includes(":")) {
    return false;
  }
  if (Math.min(ka.length, kb.length) < MIN_FAMILY_KEY) {
    return false;
  }
  return ka.startsWith(kb) || kb.startsWith(ka) || ka.endsWith(kb) || kb.endsWith(ka);
}

/** Poor-man's French stems of the meaningful words: ≥4 chars, trailing -s/-x dropped. */
export function foldStems(text: string): string[] {
  const words = foldText(text).match(/[a-z0-9à-ÿ]{4,}/g) ?? [];
  return words.map((w) =>
    w.length > 4 && (w.endsWith("s") || w.endsWith("x")) ? w.slice(0, -1) : w,
  );
}

/** Two stems relate if equal or one extends the other ("deploy" ~ "deployer"). */
function stemsRelate(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Keep only the skills that actually relate to the prompt. The Cerveau always
 * returns every `global` skill in recall mode (and an old Cerveau returns all
 * active skills) — injecting them on every turn would be recurring noise, so a
 * skill must share at least one word with the prompt (its own project counts
 * as a tie-breaker, not a free pass). Project skills rank first.
 */
export function selectPertinentSkills(
  skills: BrainSkill[],
  query: string,
  projet?: string,
): BrainSkill[] {
  const queryStems = foldStems(query);
  if (queryStems.length === 0) {
    return [];
  }
  const scored: { skill: BrainSkill; overlap: number; onProject: boolean }[] = [];
  for (const skill of skills) {
    const haystack = foldStems(
      [skill.name ?? "", skill.description ?? "", ...(skill.sujets ?? [])].join(" "),
    );
    const overlap = queryStems.filter((q) => haystack.some((h) => stemsRelate(q, h))).length;
    if (overlap === 0) {
      continue;
    }
    // Alias/family tolerant ("Haiko Mail" workspace ≈ `haikomail`-tagged skill).
    const onProject = Boolean(projet && skill.project && sameProject(skill.project, projet));
    scored.push({ skill, overlap, onProject });
  }
  scored.sort((a, b) => Number(b.onProject) - Number(a.onProject) || b.overlap - a.overlap);
  return scored.slice(0, MAX_SKILLS_INJECTED).map((s) => s.skill);
}

/**
 * Render a skill as a synthetic memory so it flows through the existing blob /
 * pill / envelope machinery unchanged (no new wire shape). The procedure is
 * bounded; the closing note already points the agent at the memory tool
 * (detail_skill) for the full text.
 */
export function skillToSouvenir(skill: BrainSkill): BrainSouvenir {
  const description = (skill.description ?? "").trim();
  const procedure = (skill.procedure ?? "").trim();
  const bounded =
    procedure.length > MAX_SKILL_PROCEDURE_CHARS
      ? `${procedure.slice(0, MAX_SKILL_PROCEDURE_CHARS)}…`
      : procedure;
  const lines = [
    `📋 Procédure « ${(skill.name ?? "").trim() || "sans nom"} »${description ? ` — ${description}` : ""}`,
  ];
  if (bounded) {
    lines.push(bounded);
  }
  return { id: skill.id, texte: lines.join("\n") };
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

// Must mirror injectBrainContext exactly: opening tag with portee, blob, closing
// tag, one-line note, blank line, then the user's own text.
const BRAIN_CONTEXT_ENVELOPE_PATTERN =
  /^<contexte_memoire source="cerveau" portee="(projet|global|apercu)">\n([\s\S]*?)\n<\/contexte_memoire>\nNote: [^\n]*\n\n([\s\S]*)$/;

const REJECTED_RECALL_LINE_PATTERN = /^⛔ \(piste écartée(?: — (.+?))?\) ([\s\S]*)$/;

export interface ParsedBrainContextEnvelope {
  portee: BrainPortee;
  memories: { texte: string; rejete?: boolean; motif?: string }[];
  userText: string;
}

/**
 * Reverse of injectBrainContext. Provider transcripts echo the prompt the
 * daemon actually sent — including the injected block — so any user message
 * rebuilt from a transcript (live echo, history replay after a refresh or
 * daemon restart) must be split back into the user's own text plus a
 * reconstructed brain_context pill instead of showing the raw XML.
 */
export function parseBrainContextEnvelope(text: string): ParsedBrainContextEnvelope | null {
  const match = BRAIN_CONTEXT_ENVELOPE_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  return {
    portee: match[1] as BrainPortee,
    memories: parseRecallBlob(match[2] ?? ""),
    userText: match[3] ?? "",
  };
}

/**
 * Best-effort reverse of formatRecall: each "- " / "⛔ " line starts a memory;
 * other lines are continuations of the previous one (memory texts may span
 * lines, and the blob may be truncated mid-entry at MAX_BLOB_CHARS).
 */
function parseRecallBlob(blob: string): { texte: string; rejete?: boolean; motif?: string }[] {
  const memories: { texte: string; rejete?: boolean; motif?: string }[] = [];
  for (const line of blob.split("\n")) {
    if (line.startsWith("- ")) {
      memories.push({ texte: line.slice(2) });
      continue;
    }
    const rejected = REJECTED_RECALL_LINE_PATTERN.exec(line);
    if (rejected) {
      memories.push({
        texte: rejected[2] ?? "",
        rejete: true,
        ...(rejected[1] ? { motif: rejected[1] } : {}),
      });
      continue;
    }
    const last = memories[memories.length - 1];
    if (last) {
      last.texte = `${last.texte}\n${line}`;
    } else if (line.trim()) {
      memories.push({ texte: line });
    }
  }
  return memories.filter((memory) => memory.texte.trim().length > 0);
}

/** Convert a memory list into the wire shape for the brain_context timeline item. */
export function toTimelineMemories(
  resultats: BrainSouvenir[],
): { texte: string; rejete?: boolean; motif?: string; date?: string }[] {
  const out: { texte: string; rejete?: boolean; motif?: string; date?: string }[] = [];
  for (const s of resultats) {
    const texte = (s.texte ?? "").trim();
    if (!texte) {
      continue;
    }
    const date = (s.date_derniere_confirmation ?? "").trim() || undefined;
    if (s.statut === "rejete") {
      out.push({ texte, rejete: true, motif: (s.motif ?? "").trim() || undefined, date });
    } else {
      out.push({ texte, date });
    }
  }
  return out;
}
