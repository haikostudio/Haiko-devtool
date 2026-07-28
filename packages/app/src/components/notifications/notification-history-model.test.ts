import { describe, expect, it } from "vitest";
import type { PushHistoryEntry } from "@getpaseo/protocol/messages";

import {
  countUnreadNotifications,
  formatUnreadBadge,
  toNotificationRowModel,
} from "./notification-history-model";

function entry(overrides: Partial<PushHistoryEntry> = {}): PushHistoryEntry {
  return {
    id: "entry-1",
    title: "Agent terminé",
    body: "Le build est vert.",
    sentAt: 1_000,
    ...overrides,
  };
}

describe("countUnreadNotifications", () => {
  it("counts only what arrived after the last open", () => {
    const entries = [entry({ id: "a", sentAt: 300 }), entry({ id: "b", sentAt: 100 })];
    expect(countUnreadNotifications(entries, 200)).toBe(1);
  });

  it("is zero right after an open", () => {
    const entries = [entry({ sentAt: 300 })];
    expect(countUnreadNotifications(entries, 300)).toBe(0);
  });

  it("stays quiet before the read marker is seeded", () => {
    expect(countUnreadNotifications([entry({ sentAt: 999 })], null)).toBe(0);
  });

  it("ignores unusable timestamps", () => {
    expect(countUnreadNotifications([entry({ sentAt: Number.NaN })], 0)).toBe(0);
  });

  it("handles an empty or missing history", () => {
    expect(countUnreadNotifications([], 0)).toBe(0);
    expect(countUnreadNotifications(null, 0)).toBe(0);
  });
});

describe("formatUnreadBadge", () => {
  it("shows the plain count", () => {
    expect(formatUnreadBadge(7)).toBe("7");
  });

  it("caps oversized counts", () => {
    expect(formatUnreadBadge(150)).toBe("99+");
  });
});

describe("toNotificationRowModel", () => {
  it("prefers the daemon-provided task, project and recap", () => {
    const model = toNotificationRowModel(
      entry({
        taskTitle: "Refondre les notifications",
        projectName: "Paseo",
        summary: "Le popover est en place. Les tests passent.",
      }),
    );
    expect(model).toEqual({
      id: "entry-1",
      taskTitle: "Refondre les notifications",
      projectName: "Paseo",
      summary: "Le popover est en place. Les tests passent.",
      sentAt: 1_000,
    });
  });

  it("falls back to title/body on entries from an older daemon", () => {
    const model = toNotificationRowModel(entry());
    expect(model.taskTitle).toBe("Agent terminé");
    expect(model.summary).toBe("Le build est vert.");
    expect(model.projectName).toBeNull();
  });

  it("drops a recap that only repeats the title", () => {
    const model = toNotificationRowModel(entry({ title: "Même texte", body: "Même texte" }));
    expect(model.summary).toBeNull();
  });

  it("treats blank fields as absent", () => {
    const model = toNotificationRowModel(
      entry({ taskTitle: "   ", projectName: "  ", summary: "   " }),
    );
    expect(model.taskTitle).toBe("Agent terminé");
    expect(model.projectName).toBeNull();
    expect(model.summary).toBe("Le build est vert.");
  });
});
