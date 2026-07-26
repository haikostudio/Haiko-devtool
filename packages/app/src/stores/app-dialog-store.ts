import { create } from "zustand";

/**
 * In-app replacement for `Alert.alert` / `window.confirm`.
 *
 * The browser's native `confirm()` renders the origin ("app.example.com
 * indique") above our own copy and ignores the app theme, so every alert and
 * confirmation goes through this queue instead and is rendered by
 * `<AppDialogHost />` with the regular sheet/modal chrome.
 */

export interface AppDialogAction {
  id: string;
  label: string;
  variant?: "default" | "secondary" | "destructive";
}

export interface AppDialogRequest {
  title: string;
  message?: string;
  /** Rendered left to right; the last one is the primary action. */
  actions: AppDialogAction[];
  /** Resolved when the dialog is dismissed (backdrop, Esc, swipe down). */
  dismissActionId?: string | null;
}

export interface PendingAppDialog extends AppDialogRequest {
  key: string;
}

interface AppDialogState {
  current: PendingAppDialog | null;
  queue: PendingAppDialog[];
  request: (request: AppDialogRequest) => Promise<string | null>;
  /** Settle `key` with the pressed action id (or null when dismissed). */
  resolve: (key: string, actionId: string | null) => void;
}

const resolvers = new Map<string, (actionId: string | null) => void>();
let nextDialogId = 1;

export const useAppDialogStore = create<AppDialogState>()((set, get) => ({
  current: null,
  queue: [],
  request: (request) => {
    const pending: PendingAppDialog = { ...request, key: `app-dialog-${nextDialogId++}` };
    return new Promise<string | null>((resolve) => {
      resolvers.set(pending.key, resolve);
      set((state) =>
        state.current === null ? { current: pending } : { queue: [...state.queue, pending] },
      );
    });
  },
  resolve: (key, actionId) => {
    const resolver = resolvers.get(key);
    if (!resolver) {
      return;
    }
    resolvers.delete(key);
    resolver(actionId);

    const state = get();
    if (state.current?.key === key) {
      // Swap the next queued dialog in directly: the sheet stays mounted and
      // only its content changes, so a burst of alerts doesn't flicker.
      const [next, ...rest] = state.queue;
      set({ current: next ?? null, queue: rest });
      return;
    }
    set({ queue: state.queue.filter((dialog) => dialog.key !== key) });
  },
}));

export function showAppDialog(request: AppDialogRequest): Promise<string | null> {
  return useAppDialogStore.getState().request(request);
}
