import { describe, expect, it, beforeEach, vi } from "vitest";

// The toast store persists its fold preference through AsyncStorage; stub it so
// the node test env doesn't reach for `window` on every write.
vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import {
  AUTO_DISMISS_FINISHED_MS,
  countToastsByCategory,
  selectAutoDismissibleKeys,
  selectFinishedToastKeys,
  selectToastKeysForCategory,
} from "@/components/agent-tasks-toast-dismissal";
import { useAgentTaskToastStore } from "@/stores/agent-task-toast-store";

function task(key: string, bucket: WorkspaceStateBucket) {
  return { key, bucket };
}

describe("selectFinishedToastKeys", () => {
  it("keeps only the finished buckets (the green-pip ones)", () => {
    expect(
      selectFinishedToastKeys([
        task("a", "done"),
        task("b", "running"),
        task("c", "needs_input"),
        task("d", "failed"),
        task("e", "attention"),
      ]),
    ).toEqual(["a", "e"]);
  });

  it("returns nothing when the pile holds no finished task", () => {
    expect(
      selectFinishedToastKeys([
        task("a", "running"),
        task("b", "needs_input"),
        task("c", "failed"),
      ]),
    ).toEqual([]);
  });

  it("preserves the pile order", () => {
    expect(
      selectFinishedToastKeys([task("z", "done"), task("y", "running"), task("x", "done")]),
    ).toEqual(["z", "x"]);
  });
});

describe("category clearing", () => {
  const pile = [
    task("a", "done"),
    task("b", "running"),
    task("c", "needs_input"),
    task("d", "failed"),
    task("e", "attention"),
    task("f", "needs_input"),
  ];

  it("clears one category at a time and never touches the running one", () => {
    expect(selectToastKeysForCategory(pile, "failed")).toEqual(["d"]);
    expect(selectToastKeysForCategory(pile, "needsInput")).toEqual(["c", "f"]);
    expect(selectToastKeysForCategory(pile, "finished")).toEqual(["a", "e"]);
    // No category ever contains a running card.
    for (const category of ["finished", "failed", "needsInput"] as const) {
      expect(selectToastKeysForCategory(pile, category)).not.toContain("b");
    }
  });

  it("counts what each category would clear", () => {
    expect(countToastsByCategory(pile)).toEqual({ finished: 2, failed: 1, needsInput: 2 });
  });

  it("counts nothing on an empty pile", () => {
    expect(countToastsByCategory([])).toEqual({ finished: 0, failed: 0, needsInput: 0 });
  });
});

describe("selectAutoDismissibleKeys", () => {
  it("only returns finished cards that have lingered past the delay", () => {
    const now = 1_000_000;
    const clocks = new Map([
      ["old", now - AUTO_DISMISS_FINISHED_MS - 1],
      ["exactly-due", now - AUTO_DISMISS_FINISHED_MS],
      ["fresh", now - 1_000],
    ]);

    expect(selectAutoDismissibleKeys(clocks, now)).toEqual(["old", "exactly-due"]);
  });

  it("returns nothing when no card has a clock", () => {
    expect(selectAutoDismissibleKeys(new Map(), 1_000_000)).toEqual([]);
  });
});

describe("agent task toast store — dismissMany", () => {
  beforeEach(() => {
    useAgentTaskToastStore.setState({
      order: new Map([
        ["running", 0],
        ["done", 1],
        ["failed", 2],
      ]),
      seq: 3,
      suppressed: new Set(),
      finishedSince: new Map([["done", 500]]),
      lastDismissal: null,
    });
  });

  it("drops only the keys it is given and leaves the rest tracked", () => {
    useAgentTaskToastStore.getState().dismissMany(["done"]);

    const { order, suppressed } = useAgentTaskToastStore.getState();
    expect([...order.keys()]).toEqual(["running", "failed"]);
    expect([...suppressed]).toEqual(["done"]);
  });

  it("is a no-op when nothing dismissible is handed over", () => {
    const before = useAgentTaskToastStore.getState().order;

    useAgentTaskToastStore.getState().dismissMany([]);
    expect(useAgentTaskToastStore.getState().order).toBe(before);

    useAgentTaskToastStore.getState().dismissMany(["never-tracked"]);
    expect(useAgentTaskToastStore.getState().order).toBe(before);
  });

  it("clears exactly the finished tasks the trash button selects", () => {
    const tracked = [task("running", "running"), task("done", "done"), task("failed", "failed")];

    useAgentTaskToastStore.getState().dismissMany(selectFinishedToastKeys(tracked));

    expect([...useAgentTaskToastStore.getState().order.keys()]).toEqual(["running", "failed"]);
  });

  it("puts the cards back in their original slots when undone", () => {
    useAgentTaskToastStore.getState().dismissMany(["done", "failed"], 10_000);
    expect(useAgentTaskToastStore.getState().lastDismissal?.at).toBe(10_000);

    useAgentTaskToastStore.getState().undoDismissal(11_000);

    const { order, suppressed, finishedSince, lastDismissal } = useAgentTaskToastStore.getState();
    // Same sequence numbers as before, so the pile order is unchanged.
    expect([...order.entries()].sort()).toEqual([
      ["done", 1],
      ["failed", 2],
      ["running", 0],
    ]);
    expect(suppressed.has("done")).toBe(false);
    // The finished card's lingering clock restarts; the failed one never had one.
    expect(finishedSince.get("done")).toBe(11_000);
    expect(finishedSince.has("failed")).toBe(false);
    expect(lastDismissal).toBeNull();
  });

  it("stops offering an undo once the window is cleared", () => {
    useAgentTaskToastStore.getState().dismissMany(["done"], 10_000);
    useAgentTaskToastStore.getState().clearDismissalUndo();

    expect(useAgentTaskToastStore.getState().lastDismissal).toBeNull();
    // Undo after the window is a no-op: the card stays cleared.
    useAgentTaskToastStore.getState().undoDismissal(12_000);
    expect([...useAgentTaskToastStore.getState().order.keys()]).toEqual(["running", "failed"]);
  });

  it("starts and stops the lingering clock as cards finish and restart", () => {
    const existingKeys = new Set(["running", "done", "failed"]);
    useAgentTaskToastStore.setState({ finishedSince: new Map() });

    useAgentTaskToastStore.getState().reconcile({
      activeKeys: ["running", "failed"],
      existingKeys,
      finishedKeys: ["done"],
      now: 4_000,
    });
    expect(useAgentTaskToastStore.getState().finishedSince.get("done")).toBe(4_000);

    // The same card gets a new prompt: it is running again, so its clock is dropped.
    useAgentTaskToastStore.getState().reconcile({
      activeKeys: ["running", "failed", "done"],
      existingKeys,
      finishedKeys: [],
      now: 5_000,
    });
    expect(useAgentTaskToastStore.getState().finishedSince.has("done")).toBe(false);
  });

  it("keeps an already-running clock instead of restarting it every tick", () => {
    const existingKeys = new Set(["running", "done", "failed"]);
    useAgentTaskToastStore.setState({ finishedSince: new Map() });
    const input = {
      activeKeys: ["running", "failed"],
      existingKeys,
      finishedKeys: ["done"],
    };

    useAgentTaskToastStore.getState().reconcile({ ...input, now: 4_000 });
    useAgentTaskToastStore.getState().reconcile({ ...input, now: 9_000 });

    expect(useAgentTaskToastStore.getState().finishedSince.get("done")).toBe(4_000);
  });
});
