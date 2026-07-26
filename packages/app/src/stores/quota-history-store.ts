import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { appendSample, type QuotaSample } from "@/components/tasks/task-quota-history";

/**
 * A rolling seven-day trace of each provider's weekly allowance, plus which
 * low-quota warnings have already been shown.
 *
 * The daemon only ever reports the CURRENT numbers — it keeps no history — so the
 * curve is built client-side from the readings this device happens to take. That
 * means a device that never opens the board records nothing, which is fine: the
 * curve is a glance aid, never an accounting record.
 */
interface QuotaHistoryState {
  samplesByProvider: Record<string, QuotaSample[]>;
  record: (providerId: string, sample: QuotaSample) => void;
  /**
   * Reset timestamp of the last weekly window we warned about, per provider. The
   * warning fires once per window: as soon as the allowance refills, the reset
   * timestamp changes and the next drop can warn again.
   */
  warnedResetByProvider: Record<string, string>;
  /** True when this provider/window pair has not been warned about yet. */
  shouldWarn: (providerId: string, resetKey: string) => boolean;
  markWarned: (providerId: string, resetKey: string) => void;
  clearWarned: (providerId: string) => void;
}

export const useQuotaHistoryStore = create<QuotaHistoryState>()(
  persist(
    (set, get) => ({
      samplesByProvider: {},
      warnedResetByProvider: {},
      record: (providerId, sample) => {
        const id = providerId.trim();
        if (!id || !Number.isFinite(sample.remainingPct)) return;
        set((state) => ({
          samplesByProvider: {
            ...state.samplesByProvider,
            [id]: appendSample(state.samplesByProvider[id] ?? [], sample),
          },
        }));
      },
      shouldWarn: (providerId, resetKey) => get().warnedResetByProvider[providerId] !== resetKey,
      markWarned: (providerId, resetKey) => {
        set((state) => ({
          warnedResetByProvider: { ...state.warnedResetByProvider, [providerId]: resetKey },
        }));
      },
      clearWarned: (providerId) => {
        set((state) => {
          if (!(providerId in state.warnedResetByProvider)) return state;
          const next = { ...state.warnedResetByProvider };
          delete next[providerId];
          return { warnedResetByProvider: next };
        });
      },
    }),
    {
      name: "quota-history",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        samplesByProvider: state.samplesByProvider,
        warnedResetByProvider: state.warnedResetByProvider,
      }),
      version: 1,
    },
  ),
);
