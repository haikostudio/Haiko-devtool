import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const NOTIFICATIONS_READ_STORAGE_KEY = "notifications-read";

interface NotificationsReadStoreState {
  /**
   * Epoch ms of the last time the notification panel was opened. Everything
   * dispatched after it counts as new. Null until the marker is seeded (fresh
   * install), which keeps the badge quiet instead of announcing a whole
   * backlog the user never asked about.
   */
  lastOpenedAt: number | null;
  /** True once the persisted marker has been read back from storage. */
  hasHydrated: boolean;
  /** Records an open — the badge drops back to zero. */
  markOpened: (at: number) => void;
  /** First run only: anchor "new" to now so old history is not announced. */
  seedIfUnset: (at: number) => void;
  setHasHydrated: () => void;
}

export const useNotificationsReadStore = create<NotificationsReadStoreState>()(
  persist(
    (set) => ({
      lastOpenedAt: null,
      hasHydrated: false,
      // Monotonic: a stale open (two windows, two devices) can never rewind the
      // marker and resurrect notifications that were already read.
      markOpened: (at) =>
        set((state) =>
          state.lastOpenedAt !== null && state.lastOpenedAt >= at ? state : { lastOpenedAt: at },
        ),
      seedIfUnset: (at) =>
        set((state) => (state.lastOpenedAt === null ? { lastOpenedAt: at } : state)),
      setHasHydrated: () => set({ hasHydrated: true }),
    }),
    {
      name: NOTIFICATIONS_READ_STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ lastOpenedAt: state.lastOpenedAt }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated();
      },
    },
  ),
);
