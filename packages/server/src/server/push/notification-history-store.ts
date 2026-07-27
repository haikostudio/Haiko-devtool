import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";

import type { PushHistoryEntry } from "@getpaseo/protocol/messages";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import type { PushPayload } from "./push-service.js";

// Keep the on-disk history bounded — the panel only ever shows the recent tail,
// and this file is rewritten on every dispatched push.
const MAX_ENTRIES = 500;

/**
 * Store for the history of dispatched push notifications.
 *
 * Every push the daemon sends is recorded here (title, body, time) so the mobile
 * app can show a "notifications received" panel newest-first. Persisted to disk
 * so the history survives daemon restarts. Only tokens live in
 * {@link import("./token-store.js").PushTokenStore}; this store holds the
 * notification contents.
 */
export class PushNotificationHistoryStore {
  private readonly logger: pino.Logger;
  private entries: PushHistoryEntry[] = [];
  private readonly filePath: string;

  constructor(logger: pino.Logger, filePath: string) {
    this.logger = logger.child({ component: "push-history-store" });
    this.filePath = filePath;
    this.loadFromDisk();
  }

  /** Record a dispatched notification. Best-effort: never throws. */
  record(payload: PushPayload): void {
    const title = payload.title ?? "";
    const body = payload.body ?? "";
    if (!title && !body) {
      return;
    }
    const entry: PushHistoryEntry = {
      id: randomUUID(),
      title,
      body,
      sentAt: Date.now(),
    };
    // Newest first; trim the oldest beyond the cap.
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this.persist();
    this.logger.debug({ total: this.entries.length }, "Recorded push notification");
  }

  /** All recorded notifications, newest first, optionally capped. */
  list(limit?: number): PushHistoryEntry[] {
    // Entries are immutable once recorded and only serialized to the wire, so a
    // shallow array copy is enough — no per-item clone needed.
    return limit && limit > 0 ? this.entries.slice(0, limit) : this.entries.slice();
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { entries?: unknown };
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.entries = entries
        .filter((entry): entry is PushHistoryEntry => isHistoryEntry(entry))
        .slice(0, MAX_ENTRIES);
      this.logger.info({ total: this.entries.length }, "Loaded push notification history");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push notification history");
    }
  }

  private persist(): void {
    try {
      const payload = JSON.stringify({ entries: this.entries }, null, 2) + "\n";
      writePrivateFileAtomicSync(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push notification history");
    }
  }
}

function isHistoryEntry(value: unknown): value is PushHistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.body === "string" &&
    typeof entry.sentAt === "number"
  );
}
