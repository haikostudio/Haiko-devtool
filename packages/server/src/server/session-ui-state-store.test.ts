import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import { createTestLogger } from "../test-utils/test-logger.js";
import { SessionUiStateStore } from "./session-ui-state-store.js";

function makeState(overrides: Partial<WorkspaceUiState> = {}): WorkspaceUiState {
  return {
    tabs: [{ tabId: "draft_1", target: { kind: "draft", draftId: "d1" }, createdAt: 1 }],
    order: ["draft_1"],
    focusedTabId: "draft_1",
    drafts: {
      "draft:srv:d1": {
        input: { text: "hello", attachments: [] },
        lifecycle: "active",
        updatedAt: 100,
        version: 1,
      },
    },
    revision: 1,
    ...overrides,
  };
}

describe("SessionUiStateStore", () => {
  let tmpDir: string;
  let filePath: string;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ui-state-"));
    filePath = path.join(tmpDir, "ui-state.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns an empty map before anything is persisted", async () => {
    const store = new SessionUiStateStore(filePath, logger);
    expect(await store.getAll()).toEqual({});
  });

  test("persists a workspace's state to disk and reads it back from a fresh store", async () => {
    const state = makeState();
    const store = new SessionUiStateStore(filePath, logger);
    await store.setWorkspace("wks_a", state);

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ wks_a: state });

    const reloaded = new SessionUiStateStore(filePath, logger);
    expect(await reloaded.getAll()).toEqual({ wks_a: state });
  });

  test("keeps distinct workspaces independent across sets", async () => {
    const store = new SessionUiStateStore(filePath, logger);
    const a = makeState();
    const b = makeState({ order: [], tabs: [], focusedTabId: null, drafts: {}, revision: 2 });
    await store.setWorkspace("wks_a", a);
    await store.setWorkspace("wks_b", b);

    expect(await store.getAll()).toEqual({ wks_a: a, wks_b: b });
  });

  test("notifies change listeners with the workspace id and new state on set", async () => {
    const store = new SessionUiStateStore(filePath, logger);
    const received: Array<{ workspaceId: string; state: WorkspaceUiState }> = [];
    store.onChange((event) => received.push(event));

    const state = makeState();
    await store.setWorkspace("wks_a", state);

    expect(received).toEqual([{ workspaceId: "wks_a", state }]);
  });

  test("stops notifying after a listener unsubscribes", async () => {
    const store = new SessionUiStateStore(filePath, logger);
    const received: unknown[] = [];
    const unsub = store.onChange((event) => received.push(event));
    unsub();

    await store.setWorkspace("wks_a", makeState());
    expect(received).toEqual([]);
  });
});
