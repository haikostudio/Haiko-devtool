import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, appendFile, access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type pino from "pino";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

/**
 * Durable, append-only conversation archive — Paseo's OWN copy of every agent
 * timeline row.
 *
 * Why this exists: without it the daemon keeps timelines in memory only and
 * rebuilds them, after every restart, by replaying the provider's private
 * history (Claude Code's session files, Codex threads). That history belongs to
 * the provider and is subject to ITS retention policy — Claude Code prunes its
 * transcripts after 30 days by default. A task whose card must stay readable
 * forever (including in the terminal "deployed" column) cannot depend on that.
 *
 * The format is one JSON object per line (`{seq,timestamp,item}`) under
 * `<paseoHome>/timelines/<agentId>.jsonl`:
 * - append-only, so a crash mid-write can lose at most the last line;
 * - a truncated/corrupt line is skipped on read rather than poisoning the file,
 *   because a partial archive still beats a blank conversation;
 * - never trimmed or rotated. "Jamais effacé" is the product promise, and item
 *   content is already bounded upstream by `limitAgentTimelineItemContent`.
 *
 * Reads hit the disk (agents are opened rarely); writes are serialized per
 * agent and the hot metadata (next seq, last row, last assistant message) is
 * cached in memory so the streaming path never re-reads a file.
 */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly directory: string;
  private readonly logger: pino.Logger;
  // Per-agent write chain: appends must not interleave, or two concurrent
  // callers could claim the same seq.
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly meta = new Map<string, AgentArchiveMeta>();

  constructor(options: { directory: string; logger: pino.Logger }) {
    this.directory = options.directory;
    this.logger = options.logger.child({ module: "agent-timeline-archive" });
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    const rows = await this.appendRows(agentId, [
      { item, timestamp: options?.timestamp ?? new Date().toISOString() },
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error(`Failed to archive timeline row for agent ${agentId}`);
    }
    return row;
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    // Seeded rows carry their own seq/timestamp from the in-memory store, but the
    // archive owns its own numbering: re-stamping keeps the file strictly
    // increasing even when a seed arrives after live rows were already written.
    await this.appendRows(
      agentId,
      rows.map((row) => ({ item: row.item, timestamp: row.timestamp })),
    );
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return (await this.loadMeta(agentId)).lastSeq;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return await this.readRows(agentId);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const meta = await this.loadMeta(agentId);
    return meta.lastItem;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const meta = await this.loadMeta(agentId);
    return meta.lastAssistantMessage;
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    // The paging/cursor semantics are non-trivial and already implemented once.
    // Rehydrate a throwaway in-memory state from the archive and reuse them
    // rather than maintaining a second, subtly different copy of that logic.
    const rows = await this.readRows(agentId);
    const view = new InMemoryAgentTimelineStore();
    view.initialize(agentId, {
      rows,
      epoch: this.epochFor(agentId),
      nextSeq: (rows.at(-1)?.seq ?? 0) + 1,
    });
    return view.fetch(agentId, options);
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.meta.delete(agentId);
    await rm(this.filePath(agentId), { force: true });
  }

  /**
   * Stable per-agent epoch. An append-only archive never renumbers, so the epoch
   * must survive restarts — deriving it from the agent id keeps client cursors
   * valid across daemon lifetimes instead of resetting them on every boot.
   */
  private epochFor(agentId: string): string {
    return createHash("sha1").update(`timeline-archive:${agentId}`).digest("hex").slice(0, 32);
  }

  private filePath(agentId: string): string {
    // Agent ids are UUIDs, but never let one escape the archive directory.
    return path.join(this.directory, `${path.basename(agentId)}.jsonl`);
  }

  private async appendRows(
    agentId: string,
    entries: readonly { item: AgentTimelineItem; timestamp: string }[],
  ): Promise<AgentTimelineRow[]> {
    const previous = this.writeChains.get(agentId) ?? Promise.resolve();
    // Queue behind whatever is already writing for this agent. The chain stored
    // back is deliberately failure-swallowing: one bad append must not poison
    // every later one, while the caller still sees its own error.
    const chained = previous.catch(() => undefined).then(() => this.writeRows(agentId, entries));
    this.writeChains.set(
      agentId,
      chained.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await chained;
  }

  private async writeRows(
    agentId: string,
    entries: readonly { item: AgentTimelineItem; timestamp: string }[],
  ): Promise<AgentTimelineRow[]> {
    const meta = await this.loadMeta(agentId);
    const rows: AgentTimelineRow[] = entries.map((entry, index) => ({
      seq: meta.lastSeq + index + 1,
      timestamp: entry.timestamp,
      item: entry.item,
    }));
    const payload = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await mkdir(this.directory, { recursive: true });
    await appendFile(this.filePath(agentId), payload, "utf8");
    const last = rows[rows.length - 1];
    if (last) {
      meta.lastSeq = last.seq;
      meta.lastItem = last.item;
    }
    for (const row of rows) {
      const text = assistantText(row.item);
      if (text !== null) {
        meta.lastAssistantMessage = text;
      }
    }
    return rows;
  }

  /**
   * Metadata needed by the append path. Derived from the file the first time an
   * agent is touched in this daemon lifetime, then kept in memory. A missing
   * file is the normal cold-start case (empty archive), not an error.
   */
  private async loadMeta(agentId: string): Promise<AgentArchiveMeta> {
    const cached = this.meta.get(agentId);
    if (cached) {
      return cached;
    }
    const meta: AgentArchiveMeta = { lastSeq: 0, lastItem: null, lastAssistantMessage: null };
    for await (const row of this.streamRows(agentId)) {
      meta.lastSeq = row.seq;
      meta.lastItem = row.item;
      const text = assistantText(row.item);
      if (text !== null) {
        meta.lastAssistantMessage = text;
      }
    }
    this.meta.set(agentId, meta);
    return meta;
  }

  private async readRows(agentId: string): Promise<AgentTimelineRow[]> {
    const rows: AgentTimelineRow[] = [];
    for await (const row of this.streamRows(agentId)) {
      rows.push(row);
    }
    return rows;
  }

  /**
   * Line-by-line read so a huge archive is never fully buffered as one string,
   * and so one unparseable line (a torn final write) costs one row instead of
   * the whole conversation.
   */
  private async *streamRows(agentId: string): AsyncGenerator<AgentTimelineRow> {
    const file = this.filePath(agentId);
    let stream: ReturnType<typeof createReadStream>;
    try {
      // Probe first: createReadStream reports a missing file asynchronously,
      // which would surface as an unhandled error rather than "empty archive".
      await access(file);
      stream = createReadStream(file, { encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, agentId }, "Failed to open the agent timeline archive");
      }
      return;
    }
    const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let skipped = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const row = parseRow(line);
        if (row === null) {
          skipped += 1;
          continue;
        }
        yield row;
      }
    } finally {
      lines.close();
      stream.destroy();
      if (skipped > 0) {
        this.logger.warn({ agentId, skipped }, "Skipped unreadable agent timeline archive lines");
      }
    }
  }
}

interface AgentArchiveMeta {
  lastSeq: number;
  lastItem: AgentTimelineItem | null;
  lastAssistantMessage: string | null;
}

function parseRow(line: string): AgentTimelineRow | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as Partial<AgentTimelineRow>;
    if (
      typeof candidate.seq !== "number" ||
      typeof candidate.timestamp !== "string" ||
      typeof candidate.item !== "object" ||
      candidate.item === null
    ) {
      return null;
    }
    return { seq: candidate.seq, timestamp: candidate.timestamp, item: candidate.item };
  } catch {
    return null;
  }
}

function assistantText(item: AgentTimelineItem): string | null {
  if (item.type !== "assistant_message") {
    return null;
  }
  const text = item.text.trim();
  return text.length > 0 ? text : null;
}
