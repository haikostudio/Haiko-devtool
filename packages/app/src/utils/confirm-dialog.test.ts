import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertDialog, confirmDialog } from "./confirm-dialog";
import { useAppDialogStore } from "@/stores/app-dialog-store";

function currentDialog() {
  const dialog = useAppDialogStore.getState().current;
  if (!dialog) {
    throw new Error("Expected a dialog to be queued");
  }
  return dialog;
}

describe("confirmDialog", () => {
  beforeEach(() => {
    useAppDialogStore.setState({ current: null, queue: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { document?: unknown }).document;
  });

  it("queues an in-app dialog instead of a native alert", async () => {
    const pending = confirmDialog({
      title: "Restart host",
      message: "This will restart the daemon.",
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      destructive: true,
    });

    const dialog = currentDialog();
    expect(dialog.title).toBe("Restart host");
    expect(dialog.message).toBe("This will restart the daemon.");
    expect(dialog.actions).toEqual([
      { id: "cancel", label: "Cancel", variant: "secondary" },
      { id: "confirm", label: "Restart", variant: "destructive" },
    ]);
    expect(dialog.dismissActionId).toBe("cancel");

    useAppDialogStore.getState().resolve(dialog.key, "confirm");
    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the dialog is cancelled or dismissed", async () => {
    const cancelled = confirmDialog({ title: "Remove", message: "Are you sure?" });
    const cancelledDialog = currentDialog();
    useAppDialogStore.getState().resolve(cancelledDialog.key, "cancel");
    await expect(cancelled).resolves.toBe(false);

    const dismissed = confirmDialog({ title: "Remove", message: "Are you sure?" });
    const dismissedDialog = currentDialog();
    useAppDialogStore.getState().resolve(dismissedDialog.key, null);
    await expect(dismissed).resolves.toBe(false);
  });

  it("blurs the focused web element so the keyboard leaves the field", async () => {
    const blur = vi.fn();
    (globalThis as { document?: unknown }).document = {
      activeElement: { blur },
    } as unknown as Document;

    const pending = confirmDialog({ title: "Restart host", message: "Restart?" });
    expect(blur).toHaveBeenCalledTimes(1);

    useAppDialogStore.getState().resolve(currentDialog().key, "cancel");
    await pending;
  });
});

describe("alertDialog", () => {
  beforeEach(() => {
    useAppDialogStore.setState({ current: null, queue: [] });
  });

  it("shows a single acknowledge action and resolves once acknowledged", async () => {
    const pending = alertDialog("Copy failed", "The clipboard is unavailable.");

    const dialog = currentDialog();
    expect(dialog.title).toBe("Copy failed");
    expect(dialog.message).toBe("The clipboard is unavailable.");
    expect(dialog.actions).toHaveLength(1);
    expect(dialog.actions[0]?.id).toBe("confirm");
    expect(dialog.dismissActionId).toBe("confirm");

    useAppDialogStore.getState().resolve(dialog.key, "confirm");
    await expect(pending).resolves.toBeUndefined();
  });
});
