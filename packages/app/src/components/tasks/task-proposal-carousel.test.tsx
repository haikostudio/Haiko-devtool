import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardHandle } from "@/data/tasks";
import type { TaskTriageProposalRef } from "@/types/stream";

// A proposal is not on the board, so the card renders straight from the pill
// payload. These tests pin the button feedback the task asked for: a loader on
// the pressed button and both buttons disabled while the resolve is in flight.

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12 },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { medium: "500", semibold: "600" },
    colors: {
      accent: "#3b82f6",
      background: "#000",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      statusSuccess: "#16a34a",
      statusDanger: "#dc2626",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return { Check: icon("Check"), ListChecks: icon("ListChecks"), X: icon("X") };
});

vi.mock("@/components/ui/select-field", () => ({
  SelectField: () => null,
}));

vi.mock("@/components/tasks/task-cost", () => ({
  resolveEffectiveExecution: () => ({
    provider: "claude",
    modelId: undefined,
    modelLabel: "Défaut",
    modelIsDefault: true,
    thinkingLabel: undefined,
    thinkingIsDefault: true,
  }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [] }),
}));

vi.mock("@/data/tasks", () => ({
  useTaskBoard: vi.fn(),
}));

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(tag, { "data-testid": testID }, children);
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    ScrollView: passthrough("div"),
    ActivityIndicator: ({ testID }: { testID?: string }) =>
      React.createElement("span", { "data-testid": testID, "data-role": "loader" }),
    TextInput: ({ value, testID }: { value?: string; testID?: string }) =>
      React.createElement("input", { "data-testid": testID, value, readOnly: true }),
    Pressable: ({
      children,
      onPress,
      disabled,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      React.createElement(
        "button",
        { type: "button", onClick: onPress, disabled: Boolean(disabled), "data-testid": testID },
        children,
      ),
  };
});

// Imported after the mocks so the module picks them up.
const { TaskProposalCards } = await import("./task-proposal-carousel");

let dom: JSDOM;
let root: Root | null = null;
let container: HTMLElement | null = null;

function click(testID: string): void {
  const node = container?.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (!node) {
    throw new Error(`Missing node: ${testID}`);
  }
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

function has(testID: string): boolean {
  return Boolean(container?.querySelector(`[data-testid="${testID}"]`));
}

function isDisabled(testID: string): boolean {
  const node = container?.querySelector<HTMLButtonElement>(`[data-testid="${testID}"]`);
  return Boolean(node?.disabled);
}

const PROPOSAL: TaskTriageProposalRef = { proposalId: "p1", title: "Ajouter le mode sombre" };

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("TaskProposalCards", () => {
  it("shows a loader on Approve and disables both buttons while the resolve runs", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveProposal = vi.fn(() => pending);
    const board = { resolveProposal } as unknown as TaskBoardHandle;

    act(() => {
      root?.render(
        React.createElement(TaskProposalCards, { board, entries: [], proposals: [PROPOSAL] }),
      );
    });

    // Idle: no loader, both buttons live.
    expect(has("task-proposal-approving-p1")).toBe(false);
    expect(isDisabled("task-proposal-approve-p1")).toBe(false);
    expect(isDisabled("task-proposal-refuse-p1")).toBe(false);

    click("task-proposal-approve-p1");

    // Approval carries the full payload; nothing is created until it resolves.
    expect(resolveProposal).toHaveBeenCalledWith({
      proposalId: "p1",
      outcome: "approve",
      proposal: { title: "Ajouter le mode sombre" },
    });
    // In flight: loader on Approve, both buttons disabled.
    expect(has("task-proposal-approving-p1")).toBe(true);
    expect(isDisabled("task-proposal-approve-p1")).toBe(true);
    expect(isDisabled("task-proposal-refuse-p1")).toBe(true);

    await act(async () => {
      release();
      await pending;
    });
    // Settled without error — in the real tray the board's resolution drops this
    // card; here it simply never surfaces an error.
    expect(has("task-proposal-error-p1")).toBe(false);
  });

  it("surfaces the error and re-enables the buttons when approval fails", async () => {
    const resolveProposal = vi.fn(() => Promise.reject(new Error("boom")));
    const board = { resolveProposal } as unknown as TaskBoardHandle;

    act(() => {
      root?.render(
        React.createElement(TaskProposalCards, { board, entries: [], proposals: [PROPOSAL] }),
      );
    });

    await act(async () => {
      click("task-proposal-approve-p1");
      await Promise.resolve();
    });

    // The failure shows inline and the buttons come back so the user can retry.
    expect(has("task-proposal-error-p1")).toBe(true);
    expect(has("task-proposal-approving-p1")).toBe(false);
    expect(isDisabled("task-proposal-approve-p1")).toBe(false);
    expect(isDisabled("task-proposal-refuse-p1")).toBe(false);
  });

  it("refuses through the resolve RPC with a loader, creating nothing", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveProposal = vi.fn(() => pending);
    const board = { resolveProposal } as unknown as TaskBoardHandle;

    act(() => {
      root?.render(
        React.createElement(TaskProposalCards, { board, entries: [], proposals: [PROPOSAL] }),
      );
    });

    click("task-proposal-refuse-p1");

    expect(resolveProposal).toHaveBeenCalledWith({ proposalId: "p1", outcome: "refuse" });
    expect(has("task-proposal-refusing-p1")).toBe(true);
    expect(isDisabled("task-proposal-approve-p1")).toBe(true);

    await act(async () => {
      release();
      await pending;
    });
    expect(has("task-proposal-error-p1")).toBe(false);
  });
});
