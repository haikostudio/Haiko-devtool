import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { foldText } from "./client.js";
import { projectBriefSlug } from "./project-brief.js";

/**
 * Per-project write-through cache of the facts the scribe just distilled. The
 * external Cerveau marks every fresh note `pending_synthesis` — NOT immediately
 * searchable — so a decision taken two prompts ago is invisible to recall until
 * the brain catches up (minutes to hours). This store keeps those facts locally
 * for a short freshness window and the recall path prepends them, so a
 * just-learned fact is usable on the very next prompt. Once the window elapses
 * we assume the Cerveau has synthesized them and let them drop; entries are also
 * deduped by folded text so re-noting the same fact just refreshes its age.
 *
 * Stored under `$PASEO_HOME/brain/recent/<slug>.json`, one file per project,
 * atomic tmp+rename writes like the fiche store. Entirely best-effort — any I/O
 * failure degrades to "no fresh facts", never blocks a prompt.
 */

const MAX_RECENT_FACTS = 40;
const DEFAULT_FRESHNESS_MS = 12 * 60 * 60 * 1000; // 12 h — long enough to bridge synthesis lag.

interface RecentFactEntry {
  texte: string;
  ts: number;
}

export interface RecentFactsStoreOptions {
  freshnessMs?: number;
  /** Injectable clock for deterministic tests; defaults to wall time. */
  now?: () => number;
}

export class RecentFactsStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly freshnessMs: number;
  private readonly now: () => number;

  constructor(dir: string, logger: Logger, options: RecentFactsStoreOptions = {}) {
    this.dir = dir;
    this.logger = logger.child({ module: "recent-facts" });
    this.freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.now = options.now ?? Date.now;
  }

  /** Record freshly distilled facts (deduped by folded text, capped, pruned). */
  async add(projet: string, facts: string[]): Promise<void> {
    const clean = facts.map((f) => f.trim()).filter(Boolean);
    if (clean.length === 0) {
      return;
    }
    const now = this.now();
    const byText = new Map<string, RecentFactEntry>();
    for (const entry of await this.read(projet)) {
      byText.set(foldText(entry.texte), entry);
    }
    for (const texte of clean) {
      byText.set(foldText(texte), { texte, ts: now });
    }
    const merged = [...byText.values()]
      .filter((entry) => now - entry.ts <= this.freshnessMs)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_RECENT_FACTS);
    await this.write(projet, merged);
  }

  /** Fresh facts for a project (within the freshness window), newest first. */
  async load(projet: string): Promise<string[]> {
    const now = this.now();
    return (await this.read(projet))
      .filter((entry) => now - entry.ts <= this.freshnessMs)
      .map((entry) => entry.texte);
  }

  private async read(projet: string): Promise<RecentFactEntry[]> {
    try {
      const raw = await readFile(this.filePath(projet), "utf8");
      const parsed = JSON.parse(raw) as { facts?: unknown };
      if (!Array.isArray(parsed.facts)) {
        return [];
      }
      return parsed.facts.filter(
        (entry): entry is RecentFactEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecentFactEntry).texte === "string" &&
          typeof (entry as RecentFactEntry).ts === "number",
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.debug({ err, projet }, "recent-facts: read failed");
      }
      return [];
    }
  }

  private async write(projet: string, entries: RecentFactEntry[]): Promise<void> {
    const target = this.filePath(projet);
    const tmp = `${target}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, `${JSON.stringify({ facts: entries })}\n`, "utf8");
      await rename(tmp, target);
    } catch (err) {
      this.logger.debug({ err, projet }, "recent-facts: write failed");
    }
  }

  private filePath(projet: string): string {
    return join(this.dir, `${projectBriefSlug(projet)}.json`);
  }
}
