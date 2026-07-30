import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type {
  UsageStatsDay,
  UsageStatsHourBucket,
  UsageStatsProjectBucket,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentUsage } from "../agent/agent-sdk-types.js";

const PROJECT_BUCKET_SCHEMA = z.object({
  name: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  costUsd: z.number(),
  turns: z.number(),
  agentIds: z.array(z.string()),
});

const DAY_FILE_SCHEMA = z.object({
  version: z.literal(1),
  date: z.string(),
  // Hour "0".."23" (daemon-local) -> project key (agent cwd) -> aggregates.
  hours: z.record(
    z.string(),
    z.object({
      projects: z.record(z.string(), PROJECT_BUCKET_SCHEMA),
    }),
  ),
});

type DayFile = z.infer<typeof DAY_FILE_SCHEMA>;
type StoredProjectBucket = z.infer<typeof PROJECT_BUCKET_SCHEMA>;

// Bound per-bucket agent id lists so a runaway loop cannot bloat day files.
// agentCount saturates at this value, which is far above any real hour.
const MAX_AGENT_IDS_PER_BUCKET = 500;

const FLUSH_DELAY_MS = 5_000;

export interface UsageStatsDeltaParams {
  timestamp: Date;
  agentId: string;
  projectKey: string;
  projectName: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  turns: number;
}

export interface NoteAgentUsageParams {
  agentId: string;
  projectKey: string;
  projectName: string;
  usage: AgentUsage;
  timestamp: Date;
  countTurn: boolean;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyDayFile(dateKey: string): DayFile {
  return { version: 1, date: dateKey, hours: {} };
}

/**
 * Persisted per-day usage aggregates: tokens, approximate cost, turns, and the
 * set of agents that worked, bucketed by hour and by project (agent cwd).
 * Backed by one JSON file per day at `$PASEO_HOME/stats/usage/YYYY-MM-DD.json`
 * with atomic, debounced writes.
 *
 * Providers report usage as cumulative counters within a live agent session.
 * `noteAgentUsage` turns those counters into deltas: per field, a value that
 * grew contributes the increase, and a value that shrank is treated as a
 * counter reset (new session) and contributes its full new value.
 */
export class UsageStatsStore {
  private readonly baseDir: string;
  private readonly logger: Logger;
  private readonly dayCache = new Map<string, DayFile>();
  private readonly dayLoadPromises = new Map<string, Promise<DayFile>>();
  private readonly pendingRecords = new Set<Promise<void>>();
  private readonly dirtyDays = new Set<string>();
  private readonly lastCumulativeByAgent = new Map<string, AgentUsage>();
  private flushTimer: NodeJS.Timeout | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private deltaListener: ((delta: UsageStatsDeltaParams) => void) | null = null;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "usage-stats-store" });
  }

  noteAgentUsage(params: NoteAgentUsageParams): void {
    const previous = this.lastCumulativeByAgent.get(params.agentId) ?? {};
    // Merge field-by-field: events often carry a subset of fields (e.g. only
    // context-window updates); absent fields must not erase the baseline.
    this.lastCumulativeByAgent.set(params.agentId, {
      inputTokens: validCounter(params.usage.inputTokens) ?? previous.inputTokens,
      outputTokens: validCounter(params.usage.outputTokens) ?? previous.outputTokens,
      cachedInputTokens: validCounter(params.usage.cachedInputTokens) ?? previous.cachedInputTokens,
      totalCostUsd: validCounter(params.usage.totalCostUsd) ?? previous.totalCostUsd,
    });

    const delta = {
      inputTokens: cumulativeDelta(params.usage.inputTokens, previous.inputTokens),
      outputTokens: cumulativeDelta(params.usage.outputTokens, previous.outputTokens),
      cachedInputTokens: cumulativeDelta(
        params.usage.cachedInputTokens,
        previous.cachedInputTokens,
      ),
      costUsd: cumulativeDelta(params.usage.totalCostUsd, previous.totalCostUsd),
    };
    const turns = params.countTurn ? 1 : 0;
    if (
      delta.inputTokens === 0 &&
      delta.outputTokens === 0 &&
      delta.cachedInputTokens === 0 &&
      delta.costUsd === 0 &&
      turns === 0
    ) {
      return;
    }

    const record = this.recordDelta({
      timestamp: params.timestamp,
      agentId: params.agentId,
      projectKey: params.projectKey,
      projectName: params.projectName,
      ...delta,
      turns,
    }).catch((error) => {
      this.logger.warn({ err: error, agentId: params.agentId }, "Failed to record usage delta");
    });
    this.pendingRecords.add(record);
    void record.finally(() => {
      this.pendingRecords.delete(record);
    });
  }

  forgetAgent(agentId: string): void {
    this.lastCumulativeByAgent.delete(agentId);
  }

  /**
   * Écoute les deltas au passage. Posé une fois au démarrage par le tableau de
   * tâches, qui les additionne sur la carte de l'agent concerné : c'est le seul
   * endroit où un delta existe déjà calculé (les fournisseurs, eux, annoncent
   * des compteurs cumulés qu'on ne peut pas additionner tels quels).
   * Volontairement synchrone et sans await : une erreur d'auditeur ne doit
   * jamais faire échouer l'enregistrement des statistiques.
   */
  setDeltaListener(listener: ((delta: UsageStatsDeltaParams) => void) | null): void {
    this.deltaListener = listener;
  }

  async recordDelta(params: UsageStatsDeltaParams): Promise<void> {
    try {
      this.deltaListener?.(params);
    } catch (error) {
      this.logger.debug({ err: error, agentId: params.agentId }, "Usage delta listener failed");
    }
    const dateKey = formatDateKey(params.timestamp);
    const hourKey = String(params.timestamp.getHours());
    const dayFile = await this.loadDay(dateKey);

    const hour = (dayFile.hours[hourKey] ??= { projects: {} });
    const bucket = (hour.projects[params.projectKey] ??= {
      name: params.projectName,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      turns: 0,
      agentIds: [],
    });

    bucket.name = params.projectName;
    bucket.inputTokens += params.inputTokens;
    bucket.outputTokens += params.outputTokens;
    bucket.cachedInputTokens += params.cachedInputTokens;
    bucket.costUsd += params.costUsd;
    bucket.turns += params.turns;
    if (
      !bucket.agentIds.includes(params.agentId) &&
      bucket.agentIds.length < MAX_AGENT_IDS_PER_BUCKET
    ) {
      bucket.agentIds.push(params.agentId);
    }

    this.dirtyDays.add(dateKey);
    this.scheduleFlush();
  }

  async query(params: { days: number; now?: Date }): Promise<UsageStatsDay[]> {
    const now = params.now ?? new Date();
    const result: UsageStatsDay[] = [];
    for (let offset = params.days - 1; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const dateKey = formatDateKey(date);
      const dayFile = await this.loadDay(dateKey);
      result.push(toUsageStatsDay(dayFile));
    }
    return result;
  }

  /** Flush pending records and writes; used on shutdown and in tests. */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.pendingRecords));
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.persistDirtyDays();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.persistDirtyDays();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private persistDirtyDays(): Promise<void> {
    const dateKeys = Array.from(this.dirtyDays);
    this.dirtyDays.clear();
    const next = this.persistQueue.then(async () => {
      for (const dateKey of dateKeys) {
        const dayFile = this.dayCache.get(dateKey);
        if (!dayFile) {
          continue;
        }
        try {
          await writeJsonFileAtomic(this.dayFilePath(dateKey), dayFile);
        } catch (error) {
          this.logger.error({ err: error, dateKey }, "Failed to persist usage stats day file");
        }
      }
      return undefined;
    });
    this.persistQueue = next.catch(() => {});
    return next;
  }

  private loadDay(dateKey: string): Promise<DayFile> {
    const cached = this.dayCache.get(dateKey);
    if (cached) {
      return Promise.resolve(cached);
    }
    // Dedupe concurrent loads: two racing loaders must share one DayFile
    // object, otherwise the loser's mutations land on an orphaned copy.
    const inFlight = this.dayLoadPromises.get(dateKey);
    if (inFlight) {
      return inFlight;
    }
    const load = (async () => {
      let dayFile: DayFile;
      try {
        const raw = await fs.readFile(this.dayFilePath(dateKey), "utf8");
        dayFile = DAY_FILE_SCHEMA.parse(JSON.parse(raw));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          this.logger.warn(
            { err: error, dateKey },
            "Failed to load usage stats day file, resetting",
          );
        }
        dayFile = emptyDayFile(dateKey);
      }
      this.dayCache.set(dateKey, dayFile);
      this.dayLoadPromises.delete(dateKey);
      return dayFile;
    })();
    this.dayLoadPromises.set(dateKey, load);
    return load;
  }

  private dayFilePath(dateKey: string): string {
    return path.join(this.baseDir, `${dateKey}.json`);
  }
}

function validCounter(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cumulativeDelta(next: number | undefined, previous: number | undefined): number {
  if (typeof next !== "number" || !Number.isFinite(next) || next < 0) {
    return 0;
  }
  const prev = typeof previous === "number" && Number.isFinite(previous) ? previous : 0;
  // A shrinking counter means the underlying session restarted; the new value
  // is a fresh count, not a correction, so it contributes in full.
  return next >= prev ? next - prev : next;
}

function toUsageStatsDay(dayFile: DayFile): UsageStatsDay {
  const hours: UsageStatsHourBucket[] = [];
  const dayProjects = new Map<string, UsageStatsProjectBucket & { agentIds: Set<string> }>();

  const hourKeys = Object.keys(dayFile.hours)
    .map((key) => Number.parseInt(key, 10))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);

  for (const hour of hourKeys) {
    const hourEntry = dayFile.hours[String(hour)];
    if (!hourEntry) {
      continue;
    }
    const projects: UsageStatsProjectBucket[] = [];
    for (const [key, bucket] of Object.entries(hourEntry.projects)) {
      projects.push({
        key,
        name: bucket.name,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedInputTokens: bucket.cachedInputTokens,
        costUsd: bucket.costUsd,
        turns: bucket.turns,
        agentCount: bucket.agentIds.length,
      });
      accumulateDayProject(dayProjects, key, bucket);
    }
    projects.sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens);
    hours.push({ hour, projects });
  }

  const projects: UsageStatsProjectBucket[] = Array.from(dayProjects.values()).map((entry) => ({
    key: entry.key,
    name: entry.name,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    costUsd: entry.costUsd,
    turns: entry.turns,
    agentCount: entry.agentIds.size,
  }));
  projects.sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens);

  return { date: dayFile.date, projects, hours };
}

function accumulateDayProject(
  dayProjects: Map<string, UsageStatsProjectBucket & { agentIds: Set<string> }>,
  key: string,
  bucket: StoredProjectBucket,
): void {
  let entry = dayProjects.get(key);
  if (!entry) {
    entry = {
      key,
      name: bucket.name,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      turns: 0,
      agentCount: 0,
      agentIds: new Set<string>(),
    };
    dayProjects.set(key, entry);
  }
  entry.name = bucket.name;
  entry.inputTokens += bucket.inputTokens;
  entry.outputTokens += bucket.outputTokens;
  entry.cachedInputTokens += bucket.cachedInputTokens;
  entry.costUsd += bucket.costUsd;
  entry.turns += bucket.turns;
  for (const agentId of bucket.agentIds) {
    entry.agentIds.add(agentId);
  }
}
