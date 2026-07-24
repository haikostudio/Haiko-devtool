import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * Persists the mapping from a Paseo project to a billing client on the
 * accounting instance. Kept daemon-side (never in the project repo) so the
 * billing relationship stays on the machine, out of version control.
 *
 * Only the identifiers are stored; the human-readable client/company labels are
 * re-resolved from the accounting API on read, so a renamed client stays
 * correct without a migration.
 */

export interface ComptaProjectLinkRecord {
  clientId: string;
  companyId: string;
  // Billable hourly rate for this project's task lines (CHF). Absent = default.
  hourlyRateChf?: number;
  // Default draft document new task lines pre-select.
  defaultDocument?: { kind: "quote" | "invoice"; id: string };
}

interface LinksFile {
  links: Record<string, ComptaProjectLinkRecord>;
}

export class ComptaLinksStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private cache: Record<string, ComptaProjectLinkRecord> | null = null;

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.filePath = path.join(options.paseoHome, "compta", "project-links.json");
    this.logger = options.logger.child({ module: "compta-links" });
  }

  private async load(): Promise<Record<string, ComptaProjectLinkRecord>> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LinksFile>;
      this.cache = parsed.links ?? {};
    } catch {
      // Missing/corrupt file starts empty — links are re-creatable by the user.
      this.cache = {};
    }
    return this.cache;
  }

  async get(projectId: string): Promise<ComptaProjectLinkRecord | null> {
    const links = await this.load();
    return links[projectId] ?? null;
  }

  async set(projectId: string, record: ComptaProjectLinkRecord | null): Promise<void> {
    const links = await this.load();
    if (record) {
      links[projectId] = record;
    } else {
      delete links[projectId];
    }
    this.cache = links;
    try {
      await writeJsonFileAtomic(this.filePath, { links } satisfies LinksFile);
    } catch (error) {
      this.logger.warn({ err: error, projectId }, "failed to persist compta project link");
      throw error;
    }
  }
}
