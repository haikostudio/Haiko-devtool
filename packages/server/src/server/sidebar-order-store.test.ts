import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { SidebarOrderStore } from "./sidebar-order-store.js";

describe("SidebarOrderStore", () => {
  let tmpDir: string;
  let filePath: string;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "sidebar-order-"));
    filePath = path.join(tmpDir, "sidebar-order.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns an empty order before anything is persisted", async () => {
    const store = new SidebarOrderStore(filePath, logger);
    expect(await store.get()).toEqual({ projectOrder: [], workspaceOrderByProject: {} });
  });

  test("persists a set order to disk and reads it back from a fresh store", async () => {
    const order = {
      projectOrder: ["proj-b", "proj-a"],
      workspaceOrderByProject: { "proj-a": ["ws-2", "ws-1"] },
    };
    const store = new SidebarOrderStore(filePath, logger);
    await store.set(order);

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(order);

    const reloaded = new SidebarOrderStore(filePath, logger);
    expect(await reloaded.get()).toEqual(order);
  });

  test("notifies change listeners with the new order on set", async () => {
    const store = new SidebarOrderStore(filePath, logger);
    const received: unknown[] = [];
    store.onChange((order) => received.push(order));

    const order = { projectOrder: ["p1"], workspaceOrderByProject: {} };
    await store.set(order);

    expect(received).toEqual([order]);
  });

  test("stops notifying after a listener unsubscribes", async () => {
    const store = new SidebarOrderStore(filePath, logger);
    const received: unknown[] = [];
    const unsub = store.onChange((order) => received.push(order));
    unsub();

    await store.set({ projectOrder: ["p1"], workspaceOrderByProject: {} });
    expect(received).toEqual([]);
  });
});
