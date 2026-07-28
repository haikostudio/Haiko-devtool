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
   * keeps finished tasks visible until the user dismisses them. `finishedKeys` (the
   * green-pip ones) also starts each card's lingering clock, so the pile can tidy
   * old finished cards away on its own.
   */
  reconcile: (input: {
    activeKeys: readonly string[];
    existingKeys: ReadonlySet<string>;
    finishedKeys?: readonly string[];
    now?: number;
  }) => void;
  /** Hide a toast (used once a finished task's agent is opened on screen). */
  dismiss: (key: AgentTaskToastKey) => void;
  /**
   * Drop a batch of toasts in one gesture (the trash button, the category menu, or
   * the lingering-time sweep). Takes an explicit key list rather than clearing
   * everything: a running task is never in that list, so it keeps its card (see
   * selectFinishedToastKeys / selectToastKeysForCategory). Records what it removed
   * so the clear can be undone.
   */
  dismissMany: (keys: readonly AgentTaskToastKey[], now?: number) => void;
  /**
   * When each currently-tracked *finished* card became finished. Drives the
   * lingering sweep (see selectAutoDismissibleKeys); an undo restarts the clock so
   * a card you just pulled back doesn't vanish again on the next tick.
   */
  finishedSince: Map<AgentTaskToastKey, number>;
  /**
   * The last batch this store removed, kept just long enough to offer an undo.
   * `entries` carries each key's original sequence number so restoring puts the
   * cards back exactly where they were in the pile rather than at the front.
   */
  lastDismissal: { entries: DismissedToastEntry[]; at: number } | null;
  /** Put the last cleared batch back, and restart its lingering clock. */
  undoDismissal: (now?: number) => void;
  /** Drop the undo offer (its window has elapsed, or it has been used). */
  clearDismissalUndo: () => void;
  /**
   * Keys the user has explicitly dismissed while their agent was still active.
   * Without this, `reconcile` would re-add a running agent's toast on the very
   * next tick and the card would appear to refuse being closed. A key leaves the
   * set as soon as its agent stops being active, so the *next* activation brings
   * the toast back — dismissing mutes this round, not the agent forever. Live
   * state, never persisted.
   */
  suppressed: Set<AgentTaskToastKey>;
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

/** One card removed by a clear, with everything needed to put it back as it was. */
export interface DismissedToastEntry {
  key: AgentTaskToastKey;
  /** Its position in the pile (the store's appearance sequence). */
  sequence: number;
  /** Whether it was a finished card, i.e. whether it owned a lingering clock. */
  wasFinished: boolean;
}

export interface ToastPosition {
  x: number;
  y: number;
}

/**
 * Start (or stop) the lingering clock of every tracked finished card. A card that
 * goes back to work loses its clock, so a later finish starts a fresh one; a card
 * that was already finished keeps the clock it had, or it would never age out.
 */
function reconcileFinishedClocks(input: {
  current: ReadonlyMap<AgentTaskToastKey, number>;
  finishedKeys: readonly string[];
  tracked: ReadonlyMap<AgentTaskToastKey, number>;
  now: number;
}): { finishedSince: Map<AgentTaskToastKey, number>; changed: boolean } {
  const { current, finishedKeys, tracked, now } = input;
  const finished = new Set(finishedKeys);
  const finishedSince = new Map(current);

  for (const key of finished) {
    if (tracked.has(key) && !finishedSince.has(key)) {
      finishedSince.set(key, now);
    }
  }
  // Deleting the current key mid-iteration is safe on a Map iterator.
  for (const key of finishedSince.keys()) {
    if (!finished.has(key) || !tracked.has(key)) {
      finishedSince.delete(key);
    }
  }

  // Compare key-by-key, not just by size: one card finishing while another goes
  // back to work keeps the size identical but must still be recorded.
  const changed =
    finishedSince.size !== current.size ||
    [...finishedSince.keys()].some((key) => !current.has(key));

  return { finishedSince, changed };
}

export const useAgentTaskToastStore = create<AgentTaskToastState>()(
  persist(
    (set) => ({
      order: new Map(),
      seq: 0,
      suppressed: new Set(),
      finishedSince: new Map(),
      lastDismissal: null,
      collapsed: null,
      setCollapsed: (collapsed) => set({ collapsed }),
      positions: {},
      setPosition: (key, position) =>
        set((state) => ({ positions: { ...state.positions, [key]: position } })),
      reconcile: ({ activeKeys, existingKeys, finishedKeys = [], now = Date.now() }) =>
        set((state) => {
          let changed = false;
          const next = new Map(state.order);
          let seq = state.seq;

          // Release the mute on any agent that has stopped being active — the
          // dismissal only covered the run the user waved away.
          const active = new Set(activeKeys);
          const suppressed = new Set(state.suppressed);
          for (const key of suppressed) {
            if (!active.has(key)) {
              suppressed.delete(key);
            }
          }
          const suppressedChanged = suppressed.size !== state.suppressed.size;

          for (const key of activeKeys) {
            if (!next.has(key) && !suppressed.has(key)) {
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

          const { finishedSince, changed: finishedChanged } = reconcileFinishedClocks({
            current: state.finishedSince,
            finishedKeys,
            tracked: next,
            now,
          });

          if (!changed && !suppressedChanged && !finishedChanged) {
            return state;
          }
          // Hand back the *same* map when a slice didn't move: the pile subscribes
          // to `order`, and a fresh-but-identical map would re-render every card
          // just because a lingering clock started somewhere.
          return {
            order: changed ? next : state.order,
            seq,
            suppressed: suppressedChanged ? suppressed : state.suppressed,
            finishedSince: finishedChanged ? finishedSince : state.finishedSince,
          };
        }),
      dismiss: (key) =>
        set((state) => {
          if (!state.order.has(key)) {
            return state;
          }
          const next = new Map(state.order);
          next.delete(key);
          const finishedSince = new Map(state.finishedSince);
          finishedSince.delete(key);
          return {
            order: next,
            suppressed: new Set(state.suppressed).add(key),
            finishedSince,
          };
        }),
      dismissMany: (keys, now = Date.now()) =>
        set((state) => {
          const removable = keys.filter((key) => state.order.has(key));
          if (removable.length === 0) {
            return state;
          }
          const next = new Map(state.order);
          const suppressed = new Set(state.suppressed);
          const finishedSince = new Map(state.finishedSince);
          const entries: DismissedToastEntry[] = [];
          for (const key of removable) {
            entries.push({
              key,
              sequence: state.order.get(key) ?? 0,
              wasFinished: state.finishedSince.has(key),
            });
            next.delete(key);
            finishedSince.delete(key);
            suppressed.add(key);
          }
          return { order: next, suppressed, finishedSince, lastDismissal: { entries, at: now } };
        }),
      undoDismissal: (now = Date.now()) =>
        set((state) => {
          if (!state.lastDismissal) {
            return state;
          }
          const next = new Map(state.order);
          const suppressed = new Set(state.suppressed);
          const finishedSince = new Map(state.finishedSince);
          for (const entry of state.lastDismissal.entries) {
            next.set(entry.key, entry.sequence);
            suppressed.delete(entry.key);
            // Restart the lingering clock, but only for cards that had one: a
            // failed or waiting card cleared from the category menu must not come
            // back with a countdown it never had.
            if (entry.wasFinished) {
              finishedSince.set(entry.key, now);
            }
          }
          return { order: next, suppressed, finishedSince, lastDismissal: null };
        }),
      clearDismissalUndo: () =>
        set((state) => (state.lastDismissal === null ? state : { lastDismissal: null })),
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
