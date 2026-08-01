import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanTask } from "@/data/tasks";
import { TaskGitHubPanel } from "./task-github-panel";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderRadius: { lg: 8, full: 999 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { semibold: "600" },
    fontFamily: { mono: "monospace" },
    colors: {
      surface1: "#111",
      surface3: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      statusDanger: "#f00",
      statusSuccess: "#0f0",
      statusWarning: "#fa0",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (component: unknown) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/external-link", () => ({
  ExternalLink: ({ href, label }: { href: string; label: string }) =>
    React.createElement("a", { href }, label),
}));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => React.createElement("span", {}, label),
}));

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    title: "Encart GitHub",
    column: "in_progress",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    links: {},
    ...overrides,
  } as KanbanTask;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(task: KanbanTask): void {
  act(() => {
    root?.render(React.createElement(TaskGitHubPanel, { task }));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function stepText(id: string): string {
  return container?.querySelector(`[data-testid="task-github-step-${id}"]`)?.textContent ?? "";
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

describe("TaskGitHubPanel", () => {
  it("shows the five steps of the journey, in order", () => {
    render(makeTask());

    for (const id of ["branch", "commit", "push", "merge", "publish"]) {
      expect(stepText(id)).toContain(`tasks.git.steps.${id}`);
    }
  });

  it("links the branch and the commit when the repository is known", () => {
    render(
      makeTask({
        git: {
          branch: "task/aa73-encart",
          commitSha: "abcdef1234567890",
          commitShortSha: "abcdef1",
          repo: {
            forge: "github",
            owner: "haikostudio",
            name: "paseo",
            webUrl: "https://github.com/haikostudio/paseo",
          },
          push: { state: "success", at: "2026-07-28T12:00:00.000Z" },
        },
      }),
    );

    const links = [...(container?.querySelectorAll("a") ?? [])].map((node) =>
      node.getAttribute("href"),
    );
    expect(links).toContain("https://github.com/haikostudio/paseo/commit/abcdef1234567890");
    expect(stepText("push")).toContain("tasks.git.states.success");
    expect(text()).not.toContain("tasks.git.noRepo");
  });

  it("stays readable without a GitHub remote: same steps, no links, one hint", () => {
    render(makeTask({ git: { branch: "task/aa73-encart" } }));

    expect(container?.querySelectorAll("a")).toHaveLength(0);
    expect(stepText("branch")).toContain("task/aa73-encart");
    expect(text()).toContain("tasks.git.noRepo");
  });

  it("says on the card itself why its merge failed", () => {
    render(
      makeTask({
        git: {
          branch: "task/aa73-encart",
          merge: {
            state: "failed",
            at: "2026-07-28T12:00:00.000Z",
            detail: "Conflit avec une autre carte du lot : la fusion a été annulée.",
          },
        },
      }),
    );

    expect(stepText("merge")).toContain("tasks.git.states.failed");
    expect(stepText("merge")).toContain("Conflit avec une autre carte du lot");
  });
});
