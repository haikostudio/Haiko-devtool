import { create } from "zustand";

// Tracks which agent "tasks" are surfaced as floating toasts in the bottom-right
// stack. A toast appears the moment an agent becomes active (running / needs
// input / attention / failed) and then persists — even after it finishes — until
// the user dismisses it by clicking a finished one. Dismissing simply drops the
// key from `order`; a finished-and-dismissed agent won't be re-added because
// reconcile only ever re-adds keys that are currently active, so a later prompt
// (which flips it back to active) makes its toast reappear as intended.

export type AgentTaskToastKey = string;

export function agentTaskToastKey(serverId: string, agentId: string): AgentTaskToastKey {
  return `${serverId}:${agentId}`;
}

interface AgentTaskToastState {
  /** Tracked toast keys mapped to their appearance sequence (for stable ordering). */
  order: Map<AgentTaskToastKey, number>;
  seq: number;
  /**
   * Add newly-active agents and drop agents that no longer exist. Never removes a
   * still-existing tracked agent just because it stopped being active — that's what
   * keeps finished tasks visible until the user dismisses them.
   */
  reconcile: (input: { activeKeys: readonly string[]; existingKeys: ReadonlySet<string> }) => void;
  /** Hide a toast (used when a finished task is clicked). */
  dismiss: (key: AgentTaskToastKey) => void;
}

export const useAgentTaskToastStore = create<AgentTaskToastState>((set) => ({
  order: new Map(),
  seq: 0,
  reconcile: ({ activeKeys, existingKeys }) =>
    set((state) => {
      let changed = false;
      const next = new Map(state.order);
      let seq = state.seq;

      for (const key of activeKeys) {
        if (!next.has(key)) {
          next.set(key, seq++);
          changed = true;
        }
      }
      for (const key of next.keys()) {
        if (!existingKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      if (!changed) {
        return state;
      }
      return { order: next, seq };
    }),
  dismiss: (key) =>
    set((state) => {
      if (!state.order.has(key)) {
        return state;
      }
      const next = new Map(state.order);
      next.delete(key);
      return { order: next };
    }),
}));
