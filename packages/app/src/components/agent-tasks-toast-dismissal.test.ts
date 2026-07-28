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
import { selectFinishedToastKeys } from "@/components/agent-tasks-toast-dismissal";
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
});
