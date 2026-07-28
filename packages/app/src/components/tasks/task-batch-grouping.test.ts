import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import {
  batchKeyForTask,
  groupTasksIntoBoardRows,
  parseBatchMarker,
  parseBatchTag,
  visibleTaskIds,
} from "./task-batch-grouping";

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Task",
    tags: [],
    column: "backlog",
    order: 0,
    origin: "manual",
    normalizedTitle: "task",
    links: { agentIds: [] },
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("parseBatchMarker", () => {
  it("reads the conductor's numbering in its usual shapes", () => {
    expect(parseBatchMarker("Refonte du tableau (2 sur 5)")).toEqual({ index: 2, total: 5 });
    expect(parseBatchMarker("2 sur 5 — Refonte du tableau")).toEqual({ index: 2, total: 5 });
    expect(parseBatchMarker("Migration [3/4]")).toEqual({ index: 3, total: 4 });
    expect(parseBatchMarker("Step 1 of 3")).toEqual({ index: 1, total: 3 });
  });

  it("prefers the wrapped marker when a title carries two candidates", () => {
    expect(parseBatchMarker("Passer 1 sur 2 écrans (3 sur 6)")).toEqual({ index: 3, total: 6 });
  });

  it("ignores impossible or implausible numbering", () => {
    expect(parseBatchMarker("Corriger 7 sur 3 lignes")).toBeNull();
    expect(parseBatchMarker("Sauvegarde du 15/07/26")).toBeNull();
    expect(parseBatchMarker("Objectif 2 sur 2026")).toBeNull();
    expect(parseBatchMarker("Nettoyer le cache")).toBeNull();
  });
});

describe("parseBatchTag", () => {
  it("lifts an explicit lot tag and normalizes it", () => {
    expect(parseBatchTag(["ui", "lot-Refonte Tableau"])).toBe("refonte tableau");
    expect(parseBatchTag(["batch: auth"])).toBe("auth");
    expect(parseBatchTag(["série-2"])).toBe("2");
  });

  it("returns null when no tag names a lot", () => {
    expect(parseBatchTag(["ui", "tableau"])).toBeNull();
    expect(parseBatchTag(["lot-"])).toBeNull();
  });
});

describe("batchKeyForTask", () => {
  it("keys by folder + total when only the numbering is present", () => {
    expect(batchKeyForTask(makeTask({ title: "Refonte (2 sur 5)" }))).toBe("num:f1:5");
  });

  it("prefers the explicit lot tag over the numbering", () => {
    expect(batchKeyForTask(makeTask({ title: "Refonte (2 sur 5)", tags: ["lot-refonte"] }))).toBe(
      "tag:f1:refonte",
    );
  });

  it("never groups a card carrying no lot signal", () => {
    expect(batchKeyForTask(makeTask({ title: "Nettoyer le cache" }))).toBeNull();
  });

  it("keeps two same-sized lots apart when they live in different folders", () => {
    const left = batchKeyForTask(makeTask({ folderId: "f1", title: "A (1 sur 3)" }));
    const right = batchKeyForTask(makeTask({ folderId: "f2", title: "B (1 sur 3)" }));
    expect(left).not.toBe(right);
  });
});

describe("groupTasksIntoBoardRows", () => {
  it("collapses a lot into one row placed where its first card sat", () => {
    const rows = groupTasksIntoBoardRows([
      makeTask({ id: "solo", title: "Nettoyer le cache" }),
      makeTask({ id: "b", title: "Colonnes (2 sur 3)" }),
      makeTask({ id: "other", title: "Revoir les libellés" }),
      makeTask({ id: "a", title: "Colonnes (1 sur 3)" }),
      makeTask({ id: "c", title: "Colonnes (3 sur 3)" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["task", "batch", "task"]);
    const batch = rows[1];
    if (batch.kind !== "batch") {
      throw new Error("expected a batch row");
    }
    // Members re-order by their numbering, not by their column position.
    expect(batch.tasks.map((task) => task.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves a lone numbered card as a plain card", () => {
    const rows = groupTasksIntoBoardRows([makeTask({ id: "a", title: "Colonnes (1 sur 3)" })]);
    expect(rows).toEqual([{ kind: "task", key: "a", task: expect.objectContaining({ id: "a" }) }]);
  });

  it("groups tagged cards even when their titles carry no numbering", () => {
    const rows = groupTasksIntoBoardRows([
      makeTask({ id: "a", title: "Écran d'accueil", tags: ["lot-onboarding"] }),
      makeTask({ id: "b", title: "Écran de fin", tags: ["lot-onboarding"] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("batch");
  });
});

describe("visibleTaskIds", () => {
  const rows = groupTasksIntoBoardRows([
    makeTask({ id: "solo", title: "Nettoyer le cache" }),
    makeTask({ id: "a", title: "Colonnes (1 sur 2)" }),
    makeTask({ id: "b", title: "Colonnes (2 sur 2)" }),
  ]);

  it("exposes only the lead card of a collapsed stack", () => {
    expect(visibleTaskIds(rows, () => false)).toEqual(["solo", "a"]);
  });

  it("exposes every card once the stack is expanded", () => {
    expect(visibleTaskIds(rows, () => true)).toEqual(["solo", "a", "b"]);
  });
});
