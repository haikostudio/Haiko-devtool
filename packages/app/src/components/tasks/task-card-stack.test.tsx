import React from "react";
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanTask } from "@/data/tasks";
import { TaskCardStack, useBatchExpansion, type RenderCardOptions } from "./task-card-stack";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8 },
    borderRadius: { md: 6, lg: 8 },
    fontSize: { xs: 11 },
    fontWeight: { medium: "500" },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      foregroundMuted: "#aaa",
      border: "#555",
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

vi.mock("@/styles/theme", () => ({ ICON_SIZE: { xs: 12, sm: 14 } }));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Layers: createIcon("Layers"),
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", {}, children),
  },
  FadeIn: { duration: () => ({}) },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", {}, children),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick: onPress, "data-testid": testID },
      children,
    ),
}));

function makeTask(id: string, title: string): KanbanTask {
  return {
    id,
    folderId: "f1",
    title,
    tags: [],
    column: "backlog",
    order: 0,
    origin: "manual",
    normalizedTitle: title.toLowerCase(),
    links: { agentIds: [] },
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  } as KanbanTask;
}

const TASKS = [
  makeTask("a", "Colonnes (1 sur 3)"),
  makeTask("b", "Colonnes (2 sur 3)"),
  makeTask("c", "Colonnes (3 sur 3)"),
];

const openTask = vi.fn();
const openMenu = vi.fn();

// Stand-in for the board's card row: the card button (whose press opens the
// task unless the pile overrides it) plus the ⋮ menu sitting beside it, exactly
// like the real boards wrap TaskCard + TaskCardMenu.
function CardStub({ task, options }: { task: KanbanTask; options?: RenderCardOptions }) {
  const overridePress = options?.onPress;
  const handlePress = useCallback(() => {
    if (overridePress) {
      overridePress(task);
      return;
    }
    openTask(task.id);
  }, [overridePress, task]);
  const handleMenu = useCallback(() => openMenu(task.id), [task.id]);
  return (
    <div>
      <button
        type="button"
        data-testid={`card-${task.id}`}
        aria-label={options?.accessibilityLabel ?? task.title}
        onClick={handlePress}
      >
        {task.title}
      </button>
      <button type="button" data-testid={`menu-${task.id}`} onClick={handleMenu}>
        ⋮
      </button>
    </div>
  );
}

const renderCard = (task: KanbanTask, options?: RenderCardOptions) => (
  <CardStub task={task} options={options} />
);

// Mirrors how a column uses the stack: expansion state on the column side, card
// rendering injected by the board.
function Harness() {
  const { isExpanded, toggleExpanded } = useBatchExpansion();
  return (
    <TaskCardStack
      batchKey="num:f1:3"
      tasks={TASKS}
      expanded={isExpanded("num:f1:3")}
      onToggle={toggleExpanded}
      renderCard={renderCard}
    />
  );
}

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

let dom: JSDOM;

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
  openTask.mockClear();
  openMenu.mockClear();
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

describe("TaskCardStack", () => {
  it("shows only the lead card while the lot is folded", () => {
    act(() => {
      root?.render(<Harness />);
    });
    expect(has("card-a")).toBe(true);
    expect(has("card-b")).toBe(false);
    expect(has("card-c")).toBe(false);
  });

  it("unfolds every card on the toggle, and folds back on a second press", () => {
    act(() => {
      root?.render(<Harness />);
    });
    click("tasks-batch-toggle-num:f1:3");
    expect(has("card-b")).toBe(true);
    expect(has("card-c")).toBe(true);
    click("tasks-batch-toggle-num:f1:3");
    expect(has("card-b")).toBe(false);
  });

  it("keeps the two gestures apart: pressing a card opens it, never folds the lot", () => {
    act(() => {
      root?.render(<Harness />);
    });
    click("tasks-batch-toggle-num:f1:3");
    click("card-b");
    expect(openTask).toHaveBeenCalledWith("b");
    // The lot is still unfolded — opening a card did not toggle it.
    expect(has("card-c")).toBe(true);
  });

  it("unfolds the lot when the folded lead card is pressed, without opening it", () => {
    act(() => {
      root?.render(<Harness />);
    });
    click("card-a");
    expect(openTask).not.toHaveBeenCalled();
    expect(has("card-b")).toBe(true);
    expect(has("card-c")).toBe(true);
  });

  it("gives the lead card its normal press back once the lot is unfolded", () => {
    act(() => {
      root?.render(<Harness />);
    });
    // First press unfolds…
    click("card-a");
    // …the second one opens the task, like any other card of the lot.
    click("card-a");
    expect(openTask).toHaveBeenCalledWith("a");
    expect(has("card-c")).toBe(true);
  });

  it("says 'unfold' on the folded lead card, and names the task once unfolded", () => {
    act(() => {
      root?.render(<Harness />);
    });
    const label = () =>
      container?.querySelector('[data-testid="card-a"]')?.getAttribute("aria-label");
    expect(label()).toBe("tasks.board.batch.expand");
    click("card-a");
    expect(label()).toBe("Colonnes (1 sur 3)");
  });

  it("leaves the ⋮ menu alone: opening it neither unfolds the lot nor opens the card", () => {
    act(() => {
      root?.render(<Harness />);
    });
    click("menu-a");
    expect(openMenu).toHaveBeenCalledWith("a");
    expect(openTask).not.toHaveBeenCalled();
    expect(has("card-b")).toBe(false);
  });
});
