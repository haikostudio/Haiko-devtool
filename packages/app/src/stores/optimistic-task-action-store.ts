import { create } from "zustand";

/**
 * Optimistic "an action I just fired is in flight" flag, keyed by task id.
 *
 * When a card is dragged into a new column (or its action button is pressed),
 * the board is moved optimistically at once, but the SERVER is what actually
 * runs the transition (approve, launch, finish). This store bridges the gap
 * between the drop and the authoritative board push so the card can show a
 * working loader the instant the gesture happens — not only once the operation
 * completes. `deriveTaskTone` reads it and reports "running" while it is set.
 *
 * It is deliberately self-clearing, exactly like the run-now bar's optimistic
 * flag: cleared the moment the next board push lands (the server's truth then
 * drives the tone), on the action's own failure (the move is rolled back), and,
 * failing both, on a hard timeout so a dropped socket can never leave a card
 * spinning forever.
 */
const PENDING_TIMEOUT_MS = 10_000;

interface OptimisticTaskActionState {
  pendingIds: ReadonlySet<string>;
  /** Mark a task as having an action in flight (idempotent, self-clearing). */
  markPending: (taskId: string) => void;
  /** Clear one task's in-flight flag (on settle or rollback). */
  clearPending: (taskId: string) => void;
  /** Clear every in-flight flag — called when an authoritative board push lands. */
  clearAll: () => void;
}

// Timers live outside the store state so they never trigger a re-render.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTimer(taskId: string): void {
  const existing = timers.get(taskId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(taskId);
  }
}

export const useOptimisticTaskActionStore = create<OptimisticTaskActionState>((set, get) => ({
  pendingIds: new Set<string>(),
  markPending: (taskId) => {
    cancelTimer(taskId);
    timers.set(
      taskId,
      setTimeout(() => {
        timers.delete(taskId);
        get().clearPending(taskId);
      }, PENDING_TIMEOUT_MS),
    );
    set((state) => {
      if (state.pendingIds.has(taskId)) {
        return state;
      }
      const next = new Set(state.pendingIds);
      next.add(taskId);
      return { pendingIds: next };
    });
  },
  clearPending: (taskId) => {
    cancelTimer(taskId);
    set((state) => {
      if (!state.pendingIds.has(taskId)) {
        return state;
      }
      const next = new Set(state.pendingIds);
      next.delete(taskId);
      return { pendingIds: next };
    });
  },
  clearAll: () => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    set((state) => (state.pendingIds.size === 0 ? state : { pendingIds: new Set<string>() }));
  },
}));
