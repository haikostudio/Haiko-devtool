import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { ActivityLogSchema, type ActivityLogEntry } from "@getpaseo/protocol/activity/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

// Keep the log bounded: one entry per agent, newest first. Well above any
// realistic number of agents a single host accumulates, but a hard backstop
// against unbounded file growth.
const MAX_ENTRIES = 1000;

const EMPTY_LOG = { version: 1 as const, entries: [] as ActivityLogEntry[] };

/**
 * Single-file JSON store for the global activity log ($PASEO_HOME/activity-log.json).
 * One entry per agent, keyed by agentId, upserted on each finished turn. Reads
 * are served from an in-memory cache; writes are atomic and serialized so
 * concurrent upserts never interleave.
 */
export class ActivityLogStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private cache: ActivityLogEntry[] | null = null;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger.child({ module: "activity-log-store" });
  }

  async list(): Promise<ActivityLogEntry[]> {
    return this.load();
  }

  /**
   * Insert or replace the entry for an agent, then return the stored entry.
   * The first-seen createdAt is preserved across updates.
   */
  async upsert(entry: ActivityLogEntry): Promise<ActivityLogEntry> {
    return this.serialize(async () => {
      const entries = await this.load();
      const existing = entries.find((candidate) => candidate.id === entry.id);
      const stored: ActivityLogEntry = existing
        ? { ...entry, createdAt: existing.createdAt }
        : entry;
      const next = entries.filter((candidate) => candidate.id !== entry.id);
      next.push(stored);
      next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const capped = next.slice(0, MAX_ENTRIES);
      await writeJsonFileAtomic(this.filePath, { version: 1, entries: capped });
      this.cache = capped;
      return stored;
    });
  }

  private async load(): Promise<ActivityLogEntry[]> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const content = await readFile(this.filePath, "utf-8");
      this.cache = ActivityLogSchema.parse(JSON.parse(content)).entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error }, "Failed to read activity log; starting empty");
      }
      this.cache = [...EMPTY_LOG.entries];
    }
    return this.cache;
  }

  private async serialize<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.mutation.catch(() => undefined).then(mutation);
    this.mutation = next;
    return next;
  }
}
