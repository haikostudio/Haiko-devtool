import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Tracks which agent "tasks" are surfaced as floating toasts in the bottom-right
// stack. A toast appears the moment an agent becomes active (running / needs
// input / attention / failed) and then persists — even after it finishes — until
// its agent is actually opened on screen (its conversation becomes a pane's
// focused tab). Dismissing simply drops the key from `order`; a finished-and-
// dismissed agent won't be re-added because
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
  /** Hide a toast (used once a finished task's agent is opened on screen). */
  dismiss: (key: AgentTaskToastKey) => void;
  /**
   * Fold preference for the floating pile, persisted so the user's choice survives
   * a reload. `null` means "auto": the stack folds itself once there are enough
   * tasks and stays open below that. An explicit `true`/`false` is the user having
   * tapped the toggle, and always wins over the auto behaviour. The live
   * `order`/`seq` bookkeeping is not persisted (it's rebuilt on every load).
   */
  collapsed: boolean | null;
  setCollapsed: (collapsed: boolean) => void;
  /**
   * Where the user has dragged the floating pile / button, as an offset (in px)
   * from its default anchored corner. Keyed per "placement" — the compact button
   * and the wide stack, and each app section (chat, tasks board, …) get their own
   * saved spot, so moving the button in one place never disturbs it in another.
   * Negative x moves it left, negative y moves it up. Persisted across reloads.
   */
  positions: Record<string, ToastPosition>;
  setPosition: (key: string, position: ToastPosition) => void;
}

export interface ToastPosition {
  x: number;
  y: number;
}

export const useAgentTaskToastStore = create<AgentTaskToastState>()(
  persist(
    (set) => ({
      order: new Map(),
      seq: 0,
      collapsed: null,
      setCollapsed: (collapsed) => set({ collapsed }),
      positions: {},
      setPosition: (key, position) =>
        set((state) => ({ positions: { ...state.positions, [key]: position } })),
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
    }),
    {
      name: "agent-task-toast",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the fold preference and drag positions are durable; the tracked-toast
      // bookkeeping is rebuilt from the live agent list on every load.
      partialize: (state) => ({ collapsed: state.collapsed, positions: state.positions }),
    },
  ),
);
