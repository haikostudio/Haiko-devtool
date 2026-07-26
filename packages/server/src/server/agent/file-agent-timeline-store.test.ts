import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";

const logger = pino({ level: "silent" });

function assistant(text: string): AgentTimelineItem {
  return { type: "assistant_message", text } as AgentTimelineItem;
}

function user(text: string): AgentTimelineItem {
  return { type: "user_message", text } as AgentTimelineItem;
}

describe("FileAgentTimelineStore", () => {
  let dir: string;
  let store: FileAgentTimelineStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-timeline-archive-"));
    store = new FileAgentTimelineStore({ directory: dir, logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an unknown agent reads as an empty archive, not an error", async () => {
    expect(await store.getCommittedRows("nobody")).toEqual([]);
    expect(await store.getLatestCommittedSeq("nobody")).toBe(0);
    expect(await store.getLastItem("nobody")).toBeNull();
    expect(await store.getLastAssistantMessage("nobody")).toBeNull();
  });

  test("keeps every row, in order, across a fresh store reading the same files", async () => {
    await store.appendCommitted("a1", user("fais le café"));
    await store.appendCommitted("a1", assistant("c'est fait"));

    // A brand-new instance stands in for a daemon restart: the whole point of
    // the archive is that history survives the process that wrote it.
    const reopened = new FileAgentTimelineStore({ directory: dir, logger });
    const rows = await reopened.getCommittedRows("a1");
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows.map((row) => (row.item as { text: string }).text)).toEqual([
      "fais le café",
      "c'est fait",
    ]);
    expect(await reopened.getLatestCommittedSeq("a1")).toBe(2);
    expect(await reopened.getLastAssistantMessage("a1")).toBe("c'est fait");
  });

  test("keeps numbering strictly increasing when appends are concurrent", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) => store.appendCommitted("a1", user(`m${index}`))),
    );
    const rows = await store.getCommittedRows("a1");
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  test("agents are isolated from each other", async () => {
    await store.appendCommitted("a1", user("un"));
    await store.appendCommitted("a2", user("deux"));
    expect((await store.getCommittedRows("a1")).length).toBe(1);
    expect((await store.getCommittedRows("a2")).length).toBe(1);
  });

  test("a torn final line costs one row, not the whole conversation", async () => {
    await store.appendCommitted("a1", user("gardé"));
    // Simulate a crash mid-write: a half-flushed JSON line at the end of file.
    await appendFile(join(dir, "a1.jsonl"), '{"seq":2,"timestamp":"2026-0', "utf8");

    const reopened = new FileAgentTimelineStore({ directory: dir, logger });
    const rows = await reopened.getCommittedRows("a1");
    expect(rows.length).toBe(1);
    expect(rows.map((row) => (row.item as { text: string }).text)).toEqual(["gardé"]);
  });

  test("appending after a torn line does not reuse a sequence number", async () => {
    await store.appendCommitted("a1", user("un"));
    await appendFile(join(dir, "a1.jsonl"), '{"seq":2,"timestamp":"tro', "utf8");

    const reopened = new FileAgentTimelineStore({ directory: dir, logger });
    await reopened.appendCommitted("a1", user("deux"));
    const seqs = (await reopened.getCommittedRows("a1")).map((row) => row.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("bulkInsert seeds a conversation in one go", async () => {
    await store.bulkInsert("a1", [
      { seq: 1, timestamp: "2026-07-27T00:00:00.000Z", item: user("a") },
      { seq: 2, timestamp: "2026-07-27T00:00:01.000Z", item: assistant("b") },
    ]);
    expect((await store.getCommittedRows("a1")).length).toBe(2);
    expect(await store.getLastAssistantMessage("a1")).toBe("b");
  });

  test("the file is append-only: an existing row is never rewritten", async () => {
    await store.appendCommitted("a1", user("premier"));
    const afterFirst = await readFile(join(dir, "a1.jsonl"), "utf8");
    await store.appendCommitted("a1", user("second"));
    const afterSecond = await readFile(join(dir, "a1.jsonl"), "utf8");
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
  });

  test("deleteAgent removes the archive", async () => {
    await store.appendCommitted("a1", user("bye"));
    await store.deleteAgent("a1");
    expect(await store.getCommittedRows("a1")).toEqual([]);
  });

  test("an unreadable archive degrades to empty instead of throwing", async () => {
    await writeFile(join(dir, "a1.jsonl"), "pas du json\ndu tout\n", "utf8");
    expect(await store.getCommittedRows("a1")).toEqual([]);
  });
});
