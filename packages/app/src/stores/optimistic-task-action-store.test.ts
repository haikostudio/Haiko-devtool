import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptimisticTaskActionStore } from "./optimistic-task-action-store";

describe("optimistic-task-action-store — retainOnly keeps a dragged card's indicator lit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useOptimisticTaskActionStore.getState().clearAll();
  });
  afterEach(() => {
    useOptimisticTaskActionStore.getState().clearAll();
    vi.useRealTimers();
  });

  it("clears every flag except the ids still in flight", () => {
    const store = useOptimisticTaskActionStore.getState();
    store.markPending("drag"); // a move the server has not reflected yet
    store.markPending("button"); // a settled button transition
    expect(useOptimisticTaskActionStore.getState().pendingIds).toEqual(new Set(["drag", "button"]));

    // An authoritative board push: the drag is still pending, the button settled.
    store.retainOnly(["drag"]);

    const pending = useOptimisticTaskActionStore.getState().pendingIds;
    expect(pending.has("drag")).toBe(true); // indicator stays lit
    expect(pending.has("button")).toBe(false); // settled flag cleared
  });

  it("behaves like clearAll when nothing must be retained", () => {
    const store = useOptimisticTaskActionStore.getState();
    store.markPending("a");
    store.markPending("b");
    store.retainOnly([]);
    expect(useOptimisticTaskActionStore.getState().pendingIds.size).toBe(0);
  });
});
