import { create } from "zustand";

/**
 * Tracks a prompt the user has already committed to sending but whose text is
 * still being produced locally (dictation finalization). The agent stream view
 * renders it as a pending user bubble with the working loader underneath so the
 * chat gives immediate feedback instead of only the composer send button.
 *
 * Keyed by `${serverId}:${agentId}`. Entries are transient: set while the
 * dictation transcript is finalizing, cleared as soon as the real submit (or a
 * cancel/failure) happens.
 */
export interface PendingSendEntry {
  /** Best-known prompt text so far (live partial transcript; may be empty). */
  text: string;
}

interface PendingSendStoreState {
  pendingSends: Map<string, PendingSendEntry>;
  setPendingSend: (serverId: string, agentId: string, entry: PendingSendEntry) => void;
  clearPendingSend: (serverId: string, agentId: string) => void;
}

export function pendingSendKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export const usePendingSendStore = create<PendingSendStoreState>((set) => ({
  pendingSends: new Map(),
  setPendingSend: (serverId, agentId, entry) =>
    set((state) => {
      const key = pendingSendKey(serverId, agentId);
      const current = state.pendingSends.get(key);
      if (current && current.text === entry.text) {
        return state;
      }
      const next = new Map(state.pendingSends);
      next.set(key, entry);
      return { pendingSends: next };
    }),
  clearPendingSend: (serverId, agentId) =>
    set((state) => {
      const key = pendingSendKey(serverId, agentId);
      if (!state.pendingSends.has(key)) {
        return state;
      }
      const next = new Map(state.pendingSends);
      next.delete(key);
      return { pendingSends: next };
    }),
}));
