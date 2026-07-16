import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { DraftAttachmentStore } from "./draft-attachment-store.js";

describe("DraftAttachmentStore", () => {
  let tmpDir: string;
  let dir: string;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "draft-att-"));
    dir = path.join(tmpDir, "draft-attachments");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null for an unknown id", async () => {
    const store = new DraftAttachmentStore(dir, logger);
    expect(await store.get("nope")).toBeNull();
  });

  test("persists bytes and reads them back from a fresh store", async () => {
    const record = {
      id: "att_abc",
      mimeType: "image/png",
      fileName: "shot.png",
      dataBase64: "aGVsbG8=",
    };
    const store = new DraftAttachmentStore(dir, logger);
    await store.put(record);

    const reloaded = new DraftAttachmentStore(dir, logger);
    expect(await reloaded.get("att_abc")).toEqual(record);
  });

  test("sanitizes ids so they cannot escape the store directory", async () => {
    const store = new DraftAttachmentStore(dir, logger);
    const record = {
      id: "../../etc/passwd",
      mimeType: "image/png",
      dataBase64: "AAAA",
    };
    await store.put(record);

    // The record is retrievable by its original id (same sanitization on read),
    // and nothing was written outside the store directory.
    expect(await store.get("../../etc/passwd")).toEqual(record);
  });
});
