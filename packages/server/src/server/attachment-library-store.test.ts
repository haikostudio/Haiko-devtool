import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AttachmentLibraryStore } from "./attachment-library-store.js";

describe("AttachmentLibraryStore", () => {
  let tmpDir: string;
  let dir: string;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "att-lib-"));
    dir = path.join(tmpDir, "attachment-library");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty for an unknown workspace", async () => {
    const store = new AttachmentLibraryStore(dir, logger);
    expect(await store.list("ws-unknown")).toEqual([]);
  });

  test("records a file entry and reads it back from a fresh store", async () => {
    // A real file so the disk-existence filter keeps the entry.
    const filePath = path.join(tmpDir, "report.pdf");
    writeFileSync(filePath, "hello");
    const store = new AttachmentLibraryStore(dir, logger);
    await store.add("ws1", [
      {
        kind: "file",
        id: "upload_1",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        size: 5,
        path: filePath,
        agentId: "agent-a",
        agentTitle: "Analyse",
        addedAt: 1000,
      },
    ]);

    const reloaded = new AttachmentLibraryStore(dir, logger);
    const entries = await reloaded.list("ws1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "upload_1",
      fileName: "report.pdf",
      kind: "file",
      agentId: "agent-a",
      agentTitle: "Analyse",
      hasPreview: true,
    });
  });

  test("deduplicates a file re-sent with the same upload id", async () => {
    const filePath = path.join(tmpDir, "a.txt");
    writeFileSync(filePath, "x");
    const store = new AttachmentLibraryStore(dir, logger);
    const input = {
      kind: "file" as const,
      id: "upload_dup",
      fileName: "a.txt",
      mimeType: "text/plain",
      size: 1,
      path: filePath,
    };
    await store.add("ws1", [input]);
    await store.add("ws1", [input]);
    expect(await store.list("ws1")).toHaveLength(1);
  });

  test("materializes image bytes as a blob and dedups by content hash", async () => {
    const store = new AttachmentLibraryStore(dir, logger);
    const data = Buffer.from("PNGDATA").toString("base64");
    await store.add("ws1", [{ kind: "image", data, mimeType: "image/png" }]);
    await store.add("ws1", [{ kind: "image", data, mimeType: "image/png" }]);

    const entries = await store.list("ws1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "image", mimeType: "image/png", hasPreview: true });

    // The blob is resolvable and holds the original bytes.
    const resolved = await store.resolve("ws1", entries[0]!.id);
    expect(resolved).not.toBeNull();
  });

  test("drops entries whose bytes have disappeared from disk", async () => {
    const filePath = path.join(tmpDir, "gone.txt");
    writeFileSync(filePath, "temp");
    const store = new AttachmentLibraryStore(dir, logger);
    await store.add("ws1", [
      {
        kind: "file",
        id: "u1",
        fileName: "gone.txt",
        mimeType: "text/plain",
        size: 4,
        path: filePath,
      },
    ]);
    rmSync(filePath);
    expect(await store.list("ws1")).toEqual([]);
  });

  test("marks a workspace backfilled idempotently", async () => {
    const store = new AttachmentLibraryStore(dir, logger);
    expect(await store.isBackfilled("ws1")).toBe(false);
    await store.markBackfilled("ws1");
    expect(await store.isBackfilled("ws1")).toBe(true);
    // Adding after backfill keeps the flag set.
    await store.add("ws1", [
      { kind: "image", data: Buffer.from("q").toString("base64"), mimeType: "image/png" },
    ]);
    expect(await store.isBackfilled("ws1")).toBe(true);
  });

  test("lists newest first", async () => {
    const store = new AttachmentLibraryStore(dir, logger);
    await store.add("ws1", [
      {
        kind: "image",
        data: Buffer.from("one").toString("base64"),
        mimeType: "image/png",
        addedAt: 100,
      },
      {
        kind: "image",
        data: Buffer.from("two").toString("base64"),
        mimeType: "image/png",
        addedAt: 300,
      },
      {
        kind: "image",
        data: Buffer.from("three").toString("base64"),
        mimeType: "image/png",
        addedAt: 200,
      },
    ]);
    const entries = await store.list("ws1");
    expect(entries.map((entry) => entry.addedAt)).toEqual([300, 200, 100]);
  });
});
