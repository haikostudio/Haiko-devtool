import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ActivityLogEntry } from "@getpaseo/protocol/activity/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ActivityLogStore } from "./store.js";

function entry(overrides: Partial<ActivityLogEntry> & { id: string }): ActivityLogEntry {
  return {
    agentId: overrides.id,
    provider: "claude",
    cwd: "/tmp/project",
    workspaceId: null,
    projectName: "project",
    title: "did a thing",
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("ActivityLogStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "activity-store-"));
    filePath = join(dir, "activity-log.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("upsert inserts a new entry and list returns it", async () => {
    const store = new ActivityLogStore(filePath, createTestLogger());
    await store.upsert(entry({ id: "a1", title: "first" }));
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("first");
  });

  test("upsert by same agentId replaces in place and preserves createdAt", async () => {
    const store = new ActivityLogStore(filePath, createTestLogger());
    await store.upsert(entry({ id: "a1", title: "first", createdAt: "2026-07-17T10:00:00.000Z" }));
    const stored = await store.upsert(
      entry({
        id: "a1",
        title: "second",
        createdAt: "2026-07-17T12:00:00.000Z",
        updatedAt: "2026-07-17T12:00:00.000Z",
      }),
    );
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("second");
    // createdAt from the first insert wins; the upsert argument is ignored.
    expect(stored.createdAt).toBe("2026-07-17T10:00:00.000Z");
    expect(entries[0]?.createdAt).toBe("2026-07-17T10:00:00.000Z");
  });

  test("list is sorted by updatedAt descending", async () => {
    const store = new ActivityLogStore(filePath, createTestLogger());
    await store.upsert(entry({ id: "old", updatedAt: "2026-07-17T09:00:00.000Z" }));
    await store.upsert(entry({ id: "new", updatedAt: "2026-07-17T11:00:00.000Z" }));
    await store.upsert(entry({ id: "mid", updatedAt: "2026-07-17T10:00:00.000Z" }));
    const ids = (await store.list()).map((item) => item.id);
    expect(ids).toEqual(["new", "mid", "old"]);
  });

  test("entries persist across store instances", async () => {
    const first = new ActivityLogStore(filePath, createTestLogger());
    await first.upsert(entry({ id: "a1", title: "persisted" }));
    const second = new ActivityLogStore(filePath, createTestLogger());
    const entries = await second.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("persisted");
  });

  test("concurrent upserts do not clobber each other", async () => {
    const store = new ActivityLogStore(filePath, createTestLogger());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.upsert(
          entry({
            id: `a${index}`,
            updatedAt: `2026-07-17T10:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        ),
      ),
    );
    const entries = await store.list();
    expect(entries).toHaveLength(20);
  });
});
