import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Which low-quota warnings have already been shown on this device.
 *
 * Device state on purpose: the trace itself belongs to the host (it polls even
 * with no client open), but "I already told you" is per person, per device.
 */
interface QuotaAlertState {
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

export const useQuotaAlertStore = create<QuotaAlertState>()(
  persist(
    (set, get) => ({
      warnedResetByProvider: {},
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
      name: "quota-alerts",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ warnedResetByProvider: state.warnedResetByProvider }),
      version: 1,
    },
  ),
);
