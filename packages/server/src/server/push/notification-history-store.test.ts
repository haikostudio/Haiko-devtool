import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import { PushHistoryEntrySchema } from "@getpaseo/protocol/messages";

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

  test("keeps task context on the entry and on the wire, across restarts", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-history-"));
    const filePath = path.join(home, "push-history.json");
    try {
      const store = new PushNotificationHistoryStore(createLogger(), filePath);
      store.record(
        { title: "Agent terminé", body: "Résumé court." },
        {
          taskTitle: "Refondre les notifications",
          projectName: "Paseo",
          summary: "Le panneau est en place. Les tests passent.",
          agentId: "agent-1",
          workspaceId: "workspace-1",
          // Blank fields must not reach the wire as empty strings.
        },
      );

      const reloaded = new PushNotificationHistoryStore(createLogger(), filePath).list();
      expect(reloaded).toHaveLength(1);
      // The panel reads these off the wire, so the entry must satisfy the schema.
      const parsed = PushHistoryEntrySchema.parse(reloaded[0]);
      expect(parsed).toMatchObject({
        taskTitle: "Refondre les notifications",
        projectName: "Paseo",
        summary: "Le panneau est en place. Les tests passent.",
        agentId: "agent-1",
        workspaceId: "workspace-1",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("omits context fields that carry nothing", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-history-"));
    const filePath = path.join(home, "push-history.json");
    try {
      const store = new PushNotificationHistoryStore(createLogger(), filePath);
      store.record(
        { title: "Terminal", body: "prêt" },
        { taskTitle: "  ", projectName: null, summary: undefined },
      );

      const entry = store.list()[0];
      expect(entry.taskTitle).toBeUndefined();
      expect(entry.projectName).toBeUndefined();
      expect(entry.summary).toBeUndefined();
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
