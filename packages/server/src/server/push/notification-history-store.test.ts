import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import { PushNotificationHistoryStore } from "./notification-history-store.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("PushNotificationHistoryStore", () => {
  test("records notifications and lists them newest first", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-history-"));
    const filePath = path.join(home, "push-history.json");
    try {
      const store = new PushNotificationHistoryStore(createLogger(), filePath);

      store.record({ title: "First", body: "one" });
      store.record({ title: "Second", body: "two" });

      const entries = store.list();
      expect(entries).toHaveLength(2);
      // Newest first.
      expect(entries[0].title).toBe("Second");
      expect(entries[1].title).toBe("First");
      expect(entries[0].sentAt).toBeGreaterThanOrEqual(entries[1].sentAt);
      expect(entries[0].id).not.toBe(entries[1].id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persists history across store instances", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-history-"));
    const filePath = path.join(home, "push-history.json");
    try {
      const store = new PushNotificationHistoryStore(createLogger(), filePath);
      store.record({ title: "Persisted", body: "kept" });

      const reloaded = new PushNotificationHistoryStore(createLogger(), filePath);
      const entries = reloaded.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("Persisted");
      expect(entries[0].body).toBe("kept");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ignores notifications with neither title nor body", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-history-"));
    const filePath = path.join(home, "push-history.json");
    try {
      const store = new PushNotificationHistoryStore(createLogger(), filePath);
      store.record({ title: "", body: "" });
      expect(store.list()).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("caps the returned list when a limit is given", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-history-"));
    const filePath = path.join(home, "push-history.json");
    try {
      const store = new PushNotificationHistoryStore(createLogger(), filePath);
      for (let i = 0; i < 5; i++) {
        store.record({ title: `n${i}`, body: "b" });
      }
      expect(store.list(2)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
