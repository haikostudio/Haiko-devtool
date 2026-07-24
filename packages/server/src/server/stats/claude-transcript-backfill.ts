import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { UsageStatsStore } from "./usage-stats-store.js";

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Approximate list prices (USD per million tokens). Cache reads are billed at
// 10% of input, cache writes at 125%. Good enough for "approximate cost" —
// live recording uses the provider-reported cost instead.
function priceForModel(model: string | undefined): ModelPricing {
  const id = (model ?? "").toLowerCase();
  if (id.includes("opus")) {
    // Opus 4.5 dropped to $5/$25; older Opus generations were $15/$75.
    const legacyOpus = /opus-(3|4-0|4-1)/.test(id) || id.includes("claude-3-opus");
    return legacyOpus
      ? { inputPerMTok: 15, outputPerMTok: 75 }
      : { inputPerMTok: 5, outputPerMTok: 25 };
  }
  if (id.includes("haiku")) {
    const legacyHaiku = id.includes("claude-3-haiku");
    return legacyHaiku
      ? { inputPerMTok: 0.25, outputPerMTok: 1.25 }
      : { inputPerMTok: 1, outputPerMTok: 5 };
  }
  // Sonnet and unknown models: middle-of-the-road Sonnet pricing.
  return { inputPerMTok: 3, outputPerMTok: 15 };
}

interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export interface ClaudeTranscriptBackfillParams {
  store: UsageStatsStore;
  markerFilePath: string;
  logger: Logger;
  claudeHomeDir?: string;
  now?: Date;
}

/**
 * One-shot backfill of historical usage from Claude Code transcripts
 * (`~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl`). Each assistant line
 * carries the per-request token usage; cost is approximated from a static
 * pricing table. Runs once — a marker file records completion, and entries
 * newer than the backfill start are skipped so live recording (which begins
 * at daemon startup) never double-counts them. Resumed/forked sessions copy
 * earlier lines into new files, so assistant entries are deduped by API
 * message id across all transcripts.
 */
export async function runClaudeTranscriptBackfill(
  params: ClaudeTranscriptBackfillParams,
): Promise<void> {
  const logger = params.logger.child({ module: "usage-stats-backfill" });
  try {
    await fs.access(params.markerFilePath);
    return; // Already backfilled.
  } catch {
    // Marker absent: proceed.
  }

  const cutoff = params.now ?? new Date();
  const projectsDir = path.join(params.claudeHomeDir ?? os.homedir(), ".claude", "projects");
  let projectDirs: string[];
  try {
    projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsDir, entry.name));
  } catch {
    logger.info({ projectsDir }, "No Claude Code transcripts found, skipping usage backfill");
    await writeMarker(params.markerFilePath, cutoff, 0, 0);
    return;
  }

  const seenMessageIds = new Set<string>();
  let files = 0;
  let entries = 0;

  for (const projectDir of projectDirs) {
    let transcriptFiles: string[];
    try {
      transcriptFiles = (await fs.readdir(projectDir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const fileName of transcriptFiles) {
      files += 1;
      const filePath = path.join(projectDir, fileName);
      try {
        entries += await backfillTranscriptFile({
          filePath,
          store: params.store,
          cutoff,
          seenMessageIds,
        });
      } catch (error) {
        logger.warn({ err: error, filePath }, "Failed to backfill transcript file");
      }
    }
  }

  await params.store.flush();
  await writeMarker(params.markerFilePath, cutoff, files, entries);
  logger.info({ files, entries }, "Claude Code usage backfill completed");
}

async function writeMarker(
  markerFilePath: string,
  cutoff: Date,
  files: number,
  entries: number,
): Promise<void> {
  await writeJsonFileAtomic(markerFilePath, {
    completedAt: new Date().toISOString(),
    cutoff: cutoff.toISOString(),
    files,
    entries,
  });
}

interface TranscriptLineContext {
  timestamp: Date;
  sessionId: string;
  projectKey: string;
  projectName: string;
  entry: Record<string, unknown>;
  message: Record<string, unknown> | undefined;
}

function parseTranscriptLine(line: string, cutoff: Date): TranscriptLineContext | null {
  if (!line.trim()) {
    return null;
  }
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const timestampRaw = entry.timestamp;
  if (typeof timestampRaw !== "string") {
    return null;
  }
  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() >= cutoff.getTime()) {
    return null;
  }
  const cwd = typeof entry.cwd === "string" && entry.cwd.length > 0 ? entry.cwd : null;
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  if (!cwd || !sessionId) {
    return null;
  }
  return {
    timestamp,
    sessionId,
    projectKey: cwd,
    projectName: path.basename(cwd),
    entry,
    message: entry.message as Record<string, unknown> | undefined,
  };
}

async function recordUserTurn(store: UsageStatsStore, ctx: TranscriptLineContext): Promise<number> {
  // Real user prompts count as turns; tool results also arrive as "user"
  // lines but carry a toolUseResult payload.
  if (ctx.entry.toolUseResult !== undefined || !ctx.message) {
    return 0;
  }
  await store.recordDelta({
    timestamp: ctx.timestamp,
    agentId: ctx.sessionId,
    projectKey: ctx.projectKey,
    projectName: ctx.projectName,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    turns: 1,
  });
  return 1;
}

async function recordAssistantUsage(
  store: UsageStatsStore,
  ctx: TranscriptLineContext,
  seenMessageIds: Set<string>,
): Promise<number> {
  const message = ctx.message;
  const usage = message?.usage as TranscriptUsage | undefined;
  if (!message || !usage) {
    return 0;
  }
  const messageId = typeof message.id === "string" ? message.id : null;
  if (messageId) {
    if (seenMessageIds.has(messageId)) {
      return 0;
    }
    seenMessageIds.add(messageId);
  }

  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  const cacheRead = readNumber(usage.cache_read_input_tokens);
  const cacheWrite = readNumber(usage.cache_creation_input_tokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
    return 0;
  }

  const model = typeof message.model === "string" ? message.model : undefined;
  const pricing = priceForModel(model);
  const costUsd =
    (inputTokens * pricing.inputPerMTok +
      cacheRead * pricing.inputPerMTok * 0.1 +
      cacheWrite * pricing.inputPerMTok * 1.25 +
      outputTokens * pricing.outputPerMTok) /
    1_000_000;

  await store.recordDelta({
    timestamp: ctx.timestamp,
    agentId: ctx.sessionId,
    projectKey: ctx.projectKey,
    projectName: ctx.projectName,
    inputTokens,
    outputTokens,
    cachedInputTokens: cacheRead + cacheWrite,
    costUsd,
    turns: 0,
  });
  return 1;
}

async function backfillTranscriptFile(params: {
  filePath: string;
  store: UsageStatsStore;
  cutoff: Date;
  seenMessageIds: Set<string>;
}): Promise<number> {
  const stream = createReadStream(params.filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let recorded = 0;

  try {
    for await (const line of lines) {
      const ctx = parseTranscriptLine(line, params.cutoff);
      if (!ctx) {
        continue;
      }
      if (ctx.entry.type === "user") {
        recorded += await recordUserTurn(params.store, ctx);
      } else if (ctx.entry.type === "assistant") {
        recorded += await recordAssistantUsage(params.store, ctx, params.seenMessageIds);
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return recorded;
}
