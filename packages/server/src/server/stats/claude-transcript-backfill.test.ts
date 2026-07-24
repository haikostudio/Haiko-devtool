import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";

import { runClaudeTranscriptBackfill } from "./claude-transcript-backfill.js";
import { UsageStatsStore } from "./usage-stats-store.js";

const logger = pino({ level: "silent" });

function assistantLine(params: {
  timestamp: string;
  cwd: string;
  sessionId: string;
  messageId: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: params.timestamp,
    cwd: params.cwd,
    sessionId: params.sessionId,
    message: {
      id: params.messageId,
      model: params.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: params.input ?? 0,
        output_tokens: params.output ?? 0,
        cache_read_input_tokens: params.cacheRead ?? 0,
        cache_creation_input_tokens: params.cacheWrite ?? 0,
      },
    },
  });
}

function userLine(params: { timestamp: string; cwd: string; sessionId: string }): string {
  return JSON.stringify({
    type: "user",
    timestamp: params.timestamp,
    cwd: params.cwd,
    sessionId: params.sessionId,
    message: { role: "user", content: "do the thing" },
  });
}

describe("runClaudeTranscriptBackfill", () => {
  let tmpDir: string;
  let claudeHome: string;
  let statsDir: string;
  let markerPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-backfill-"));
    claudeHome = path.join(tmpDir, "home");
    statsDir = path.join(tmpDir, "stats", "usage");
    markerPath = path.join(tmpDir, "stats", "claude-backfill.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(project: string, file: string, lines: string[]): Promise<void> {
    const dir = path.join(claudeHome, ".claude", "projects", project);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), `${lines.join("\n")}\n`, "utf8");
  }

  it("aggregates transcript usage into the store with approximate cost", async () => {
    const cwd = "/repo/alpha";
    await writeTranscript("-repo-alpha", "session-1.jsonl", [
      userLine({ timestamp: "2026-07-10T09:05:00Z", cwd, sessionId: "session-1" }),
      assistantLine({
        timestamp: "2026-07-10T09:05:10Z",
        cwd,
        sessionId: "session-1",
        messageId: "msg-1",
        input: 1_000_000,
        output: 1_000_000,
      }),
    ]);

    const store = new UsageStatsStore(statsDir, logger);
    await runClaudeTranscriptBackfill({
      store,
      markerFilePath: markerPath,
      logger,
      claudeHomeDir: claudeHome,
      now: new Date("2026-07-16T00:00:00Z"),
    });

    const backfillDate = new Date("2026-07-10T09:05:10Z");
    const [day] = await store.query({ days: 1, now: backfillDate });
    const project = day.projects[0];
    expect(project.key).toBe(cwd);
    expect(project.name).toBe("alpha");
    expect(project.inputTokens).toBe(1_000_000);
    expect(project.outputTokens).toBe(1_000_000);
    expect(project.turns).toBe(1);
    expect(project.agentCount).toBe(1);
    // Opus 4.8: $5/MTok in + $25/MTok out.
    expect(project.costUsd).toBeCloseTo(30);
  });

  it("dedupes assistant messages copied into resumed session files", async () => {
    const cwd = "/repo/alpha";
    const line = assistantLine({
      timestamp: "2026-07-10T09:05:10Z",
      cwd,
      sessionId: "session-1",
      messageId: "msg-dup",
      input: 100,
      output: 10,
    });
    await writeTranscript("-repo-alpha", "session-1.jsonl", [line]);
    await writeTranscript("-repo-alpha", "session-2.jsonl", [line]);

    const store = new UsageStatsStore(statsDir, logger);
    await runClaudeTranscriptBackfill({
      store,
      markerFilePath: markerPath,
      logger,
      claudeHomeDir: claudeHome,
      now: new Date("2026-07-16T00:00:00Z"),
    });

    const [day] = await store.query({ days: 1, now: new Date("2026-07-10T09:05:10Z") });
    expect(day.projects[0]?.inputTokens).toBe(100);
  });

  it("skips entries newer than the cutoff and is a no-op once the marker exists", async () => {
    const cwd = "/repo/alpha";
    await writeTranscript("-repo-alpha", "session-1.jsonl", [
      assistantLine({
        timestamp: "2026-07-20T09:00:00Z",
        cwd,
        sessionId: "session-1",
        messageId: "msg-future",
        input: 100,
        output: 10,
      }),
    ]);

    const store = new UsageStatsStore(statsDir, logger);
    const params = {
      store,
      markerFilePath: markerPath,
      logger,
      claudeHomeDir: claudeHome,
      now: new Date("2026-07-16T00:00:00Z"),
    };
    await runClaudeTranscriptBackfill(params);

    const [day] = await store.query({ days: 1, now: new Date("2026-07-20T09:00:00Z") });
    expect(day.projects).toHaveLength(0);

    // Marker written: a second run must not re-process anything.
    await expect(fs.access(markerPath)).resolves.toBeUndefined();
    await runClaudeTranscriptBackfill(params);
  });
});
