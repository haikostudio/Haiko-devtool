import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanTask } from "@/data/tasks";
import { TaskBillingView } from "./task-billing-view";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderRadius: { lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", semibold: "600" },
    colors: {
      surface0: "#000",
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      success: "#0f0",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return { CheckCircle2: createIcon("CheckCircle2"), Receipt: createIcon("Receipt") };
});

// Faithful stand-in for the real form input: AdaptiveTextInput is native-owned,
// so it DROPS `value` and only seeds from `initialValue` at mount, remounting on
// `resetKey`. Reproducing that contract here is the point of these tests — a view
// that goes back to passing `value` renders blank, exactly like in production.
vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children }: { children?: React.ReactNode }) => React.createElement("div", {}, children),
  FormTextInput: ({
    initialValue,
    resetKey,
    testID,
  }: {
    value?: string;
    initialValue?: string;
    resetKey?: string | number;
    testID?: string;
  }) =>
    React.createElement("input", {
      key: resetKey,
      "data-testid": testID,
      defaultValue: initialValue ?? "",
    }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("button", { "data-testid": testID, type: "button" }, children),
}));

vi.mock("@/components/compta/task-billing-add-sheet", () => ({ TaskBillingAddSheet: () => null }));
vi.mock("@/components/compta/compta-client-picker-sheet", () => ({
  ComptaClientPickerSheet: () => null,
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => false }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    title: "Afficher les données facturation après estimation",
    description: "Le formulaire reste vide.\nIl doit afficher l'estimation.\nLigne 3.\nLigne 4.",
    column: "done",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    links: {},
    ...overrides,
  } as KanbanTask;
}

const analyzedEstimate = {
  tokens: 95000,
  quotaPercent: 5,
  confidence: "high" as const,
  model: "claude",
  estimatedAt: "2026-07-28T11:00:00.000Z",
  billingTitle: "Formulaire facturation pré-rempli",
  billingDescription: "Les champs affichent l'estimation.",
  billingHours: 1.5,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(task: KanbanTask): void {
  act(() => {
    root?.render(
      React.createElement(TaskBillingView, { task, serverId: "srv", projectId: "proj" }),
    );
  });
}

function inputValue(testID: string): string {
  const node = container?.querySelector<HTMLInputElement>(`[data-testid="${testID}"]`);
  if (!node) {
    throw new Error(`Missing input: ${testID}`);
  }
  return node.value;
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("TaskBillingView", () => {
  it("pre-fills the three fields from the analysis estimate", () => {
    render(makeTask({ estimate: analyzedEstimate }));

    expect(inputValue("task-billing-title")).toBe("Formulaire facturation pré-rempli");
    expect(inputValue("task-billing-description")).toBe("Les champs affichent l'estimation.");
    expect(inputValue("task-billing-hours")).toBe("1.5");
  });

  it("falls back to the task's own title and description when the agent omitted them", () => {
    render(makeTask({ estimate: { ...analyzedEstimate, billingTitle: undefined } }));

    // Invoice labels stay short: first five words of the task title.
    expect(inputValue("task-billing-title")).toBe("Afficher les données facturation après");
  });

  it("seeds a conservative hour count when the estimate carries none", () => {
    render(makeTask({ estimate: { ...analyzedEstimate, billingHours: undefined } }));

    expect(inputValue("task-billing-hours")).toBe("1");
  });

  it("leaves the hours blank on a task that was never analyzed", () => {
    render(makeTask());

    expect(inputValue("task-billing-hours")).toBe("");
  });

  it("re-seeds the fields when a fresh estimate lands on the open task", () => {
    const task = makeTask();
    render(task);
    expect(inputValue("task-billing-hours")).toBe("");

    render(makeTask({ estimate: analyzedEstimate }));

    expect(inputValue("task-billing-title")).toBe("Formulaire facturation pré-rempli");
    expect(inputValue("task-billing-hours")).toBe("1.5");
  });

  it("keeps a user edit across an unrelated re-render of the same task", () => {
    const task = makeTask({ estimate: analyzedEstimate });
    render(task);

    const hours = container?.querySelector<HTMLInputElement>('[data-testid="task-billing-hours"]');
    act(() => {
      if (hours) {
        hours.value = "3";
      }
    });

    // Same seed → same reset key → the native input is not remounted.
    render(makeTask({ estimate: analyzedEstimate, updatedAt: "2026-07-28T12:00:00.000Z" }));

    expect(inputValue("task-billing-hours")).toBe("3");
  });
});
