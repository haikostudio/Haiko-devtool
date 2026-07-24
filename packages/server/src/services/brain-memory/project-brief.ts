import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { foldText } from "./client.js";

/**
 * Per-project "fiche" (brief): a short curated markdown snapshot of what the
 * project is, its structure highlights, current work and standing decisions —
 * the context that is NOT derivable from the repo itself. Injected at the head
 * of the Cerveau recall on the FIRST prompt of a conversation, and rewritten by
 * the scribe (BrainCurator.distillExchange) as exchanges reshape the picture.
 *
 * Stored under `$PASEO_HOME/brain/fiches/<slug>.md`, one file per project,
 * atomic tmp+rename writes like every other file-backed store.
 */

// The scribe is asked for ≤3000 chars; the cap is a defensive bound, not a target.
const MAX_BRIEF_CHARS = 6_000;

/** "Éloya SaaS" → "eloya-saas". Never empty. */
export function projectBriefSlug(projet: string): string {
  const slug = foldText(projet)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "projet";
}

export class ProjectBriefStore {
  private readonly dir: string;
  private readonly logger: Logger;

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger.child({ module: "project-brief" });
  }

  /** Load the project's fiche. Null when absent or unreadable (best-effort). */
  async load(projet: string): Promise<string | null> {
    try {
      const content = await readFile(this.filePath(projet), "utf8");
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.debug({ err, projet }, "fiche: load failed");
      }
      return null;
    }
  }

  /**
   * Milliseconds since the fiche was last written, or null when absent. Feeds
   * the scribe's staleness nudge so a long-untouched fiche gets re-examined.
   */
  async ageMs(projet: string): Promise<number | null> {
    try {
      const stats = await stat(this.filePath(projet));
      return Math.max(0, Date.now() - stats.mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.debug({ err, projet }, "fiche: stat failed");
      }
      return null;
    }
  }

  /** Persist the fiche (trimmed, bounded). Empty content is ignored. */
  async save(projet: string, content: string): Promise<void> {
    const trimmed = content.trim().slice(0, MAX_BRIEF_CHARS);
    if (!trimmed) {
      return;
    }
    const target = this.filePath(projet);
    const tmp = `${target}.tmp`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, `${trimmed}\n`, "utf8");
    await rename(tmp, target);
  }

  private filePath(projet: string): string {
    return join(this.dir, `${projectBriefSlug(projet)}.md`);
  }
}
