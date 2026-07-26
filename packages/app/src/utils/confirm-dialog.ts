import { i18n } from "@/i18n/i18next";
import { isNative } from "@/constants/platform";
import { showAppDialog } from "@/stores/app-dialog-store";

/**
 * Alerts and confirmations always render in-app (see `<AppDialogHost />`).
 * Native OS dialogs — `Alert.alert`, `window.confirm`, the Electron dialog
 * bridge — are deliberately not used: the browser prefixes them with the origin
 * ("app.example.com indique"), they ignore the theme, and they block the JS
 * thread.
 */

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

const CONFIRM_ACTION_ID = "confirm";
const CANCEL_ACTION_ID = "cancel";

function blurActiveWebElement(): void {
  if (isNative) {
    return;
  }
  const activeElement = (globalThis as { document?: Document }).document?.activeElement;
  (activeElement as HTMLElement | null)?.blur?.();
}

export async function confirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  blurActiveWebElement();

  const actionId = await showAppDialog({
    title: input.title,
    message: input.message,
    actions: [
      {
        id: CANCEL_ACTION_ID,
        label: input.cancelLabel ?? i18n.t("common.actions.cancel"),
        variant: "secondary",
      },
      {
        id: CONFIRM_ACTION_ID,
        label: input.confirmLabel ?? i18n.t("common.actions.confirm"),
        variant: input.destructive ? "destructive" : "default",
      },
    ],
    dismissActionId: CANCEL_ACTION_ID,
  });

  return actionId === CONFIRM_ACTION_ID;
}

/**
 * Single-button notice — the in-app replacement for `Alert.alert(title, message)`.
 * Signature mirrors `Alert.alert` on purpose so call sites read the same.
 */
export async function alertDialog(
  title: string,
  message?: string,
  confirmLabel?: string,
): Promise<void> {
  blurActiveWebElement();

  await showAppDialog({
    title,
    message,
    actions: [
      {
        id: CONFIRM_ACTION_ID,
        label: confirmLabel ?? i18n.t("common.actions.ok"),
        variant: "default",
      },
    ],
    dismissActionId: CONFIRM_ACTION_ID,
  });
}

export const __private__ = {
  blurActiveWebElement,
};
