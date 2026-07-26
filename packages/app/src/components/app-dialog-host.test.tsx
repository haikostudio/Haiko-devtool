import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialogHost } from "./app-dialog-host";
import { showAppDialog, useAppDialogStore } from "@/stores/app-dialog-store";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 4: 16 },
    fontSize: { sm: 13 },
    colors: { foregroundMuted: "#aaa" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    visible,
    header,
    children,
    onClose,
    testID,
  }: {
    visible: boolean;
    header: { title: string };
    children: React.ReactNode;
    onClose: () => void;
    testID?: string;
  }) => {
    if (!visible) return null;
    return ReactModule.createElement(
      "div",
      { "data-testid": testID ?? "adaptive-modal-sheet", "data-modal-title": header.title },
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": "app-dialog-dismiss", onClick: onClose },
        "Close",
      ),
      children,
    );
  };
  return { AdaptiveModalSheet };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": testID, onClick: () => onPress?.() },
        children,
      ),
  };
});

let root: Root | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  useAppDialogStore.setState({ current: null, queue: [] });

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<AppDialogHost />);
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  vi.unstubAllGlobals();
});

function click(testID: string): void {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testID}"]`);
  if (!button) {
    throw new Error(`Missing button ${testID}`);
  }
  act(() => {
    button.click();
  });
}

describe("AppDialogHost", () => {
  it("renders nothing until a dialog is requested", () => {
    expect(document.querySelector('[data-testid="app-dialog"]')).toBeNull();
  });

  it("renders the queued dialog and resolves with the pressed action", async () => {
    let pending: Promise<string | null> | null = null;
    act(() => {
      pending = showAppDialog({
        title: "Validate task",
        message: "The task moves to Done.",
        actions: [
          { id: "cancel", label: "Cancel", variant: "secondary" },
          { id: "confirm", label: "Validate" },
        ],
        dismissActionId: "cancel",
      });
    });

    const sheet = document.querySelector('[data-testid="app-dialog"]');
    expect(sheet?.getAttribute("data-modal-title")).toBe("Validate task");
    expect(document.querySelector('[data-testid="app-dialog-message"]')?.textContent).toBe(
      "The task moves to Done.",
    );

    click("app-dialog-action-confirm");

    await expect(pending).resolves.toBe("confirm");
    expect(document.querySelector('[data-testid="app-dialog"]')).toBeNull();
  });

  it("resolves with the dismiss action when the sheet is closed", async () => {
    let pending: Promise<string | null> | null = null;
    act(() => {
      pending = showAppDialog({
        title: "Remove project",
        actions: [{ id: "cancel", label: "Cancel" }],
        dismissActionId: "cancel",
      });
    });

    click("app-dialog-dismiss");

    await expect(pending).resolves.toBe("cancel");
  });
});
