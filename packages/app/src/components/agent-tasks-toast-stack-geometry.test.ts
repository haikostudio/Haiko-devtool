import { describe, expect, it } from "vitest";
import {
  EXPANDED_GAP,
  MAX_RENDERED_TOASTS,
  collapsedPeek,
  collapsedStackHeight,
  selectRenderedToasts,
  toastStackSlot,
} from "./agent-tasks-toast-stack-geometry";

const CARD = 52;

describe("collapsedPeek", () => {
  it("gives the front card no peek", () => {
    expect(collapsedPeek(0)).toBe(0);
  });

  it("shrinks with depth and never goes below the floor", () => {
    const peeks = [1, 2, 3, 4, 5, 6].map(collapsedPeek);
    for (let i = 1; i < peeks.length; i += 1) {
      expect(peeks[i]).toBeLessThanOrEqual(peeks[i - 1] as number);
    }
    expect(Math.min(...peeks)).toBeGreaterThan(0);
  });
});

describe("toastStackSlot", () => {
  it("leaves the open pile spaced out, not folded", () => {
    const slot = toastStackSlot({ depth: 2, renderedCount: 4, cardHeight: CARD, collapsed: false });
    expect(slot.overlap).toBe(EXPANDED_GAP);
    expect(slot.opacity).toBe(1);
    expect(slot.scale).toBe(1);
  });

  it("keeps the front card fully lit and in front when folded", () => {
    const slot = toastStackSlot({ depth: 0, renderedCount: 4, cardHeight: CARD, collapsed: true });
    expect(slot.overlap).toBe(EXPANDED_GAP);
    expect(slot.opacity).toBe(1);
    expect(slot.zIndex).toBe(4);
  });

  it("stacks deeper cards behind the front one", () => {
    const front = toastStackSlot({ depth: 0, renderedCount: 3, cardHeight: CARD, collapsed: true });
    const behind = toastStackSlot({
      depth: 1,
      renderedCount: 3,
      cardHeight: CARD,
      collapsed: true,
    });
    const deepest = toastStackSlot({
      depth: 2,
      renderedCount: 3,
      cardHeight: CARD,
      collapsed: true,
    });

    expect(front.zIndex).toBeGreaterThan(behind.zIndex);
    expect(behind.zIndex).toBeGreaterThan(deepest.zIndex);
    expect(behind.opacity).toBeGreaterThan(deepest.opacity);
    expect(behind.scale).toBeGreaterThan(deepest.scale);
    // Deeper cards sit closer to the one in front: more overlap, smaller sliver.
    expect(deepest.overlap).toBeLessThan(behind.overlap);
  });

  it("does not overlap before the card has been measured", () => {
    const slot = toastStackSlot({ depth: 1, renderedCount: 2, cardHeight: 0, collapsed: true });
    expect(slot.overlap).toBe(0);
  });
});

describe("collapsedStackHeight", () => {
  it("is empty for an empty pile", () => {
    expect(collapsedStackHeight([])).toBe(0);
  });

  it("is materially shorter than the old flat pile", () => {
    // Before: a constant 10px peek plus the column's 8px flex gap on every card.
    const legacyStep = 10 + EXPANDED_GAP;
    const heights = Array.from({ length: 5 }, () => CARD);
    const legacy = CARD + (heights.length - 1) * legacyStep;
    expect(collapsedStackHeight(heights)).toBeLessThan(legacy * 0.7);
  });

  it("flattens out as cards are added", () => {
    const growth = (n: number) =>
      collapsedStackHeight(Array.from({ length: n }, () => CARD)) -
      collapsedStackHeight(Array.from({ length: n - 1 }, () => CARD));
    expect(growth(5)).toBeLessThan(growth(2));
  });
});

describe("selectRenderedToasts", () => {
  it("keeps everything below the cap", () => {
    const { rendered, hiddenCount } = selectRenderedToasts(["a", "b"]);
    expect(rendered).toEqual(["a", "b"]);
    expect(hiddenCount).toBe(0);
  });

  it("drops the oldest cards once saturated", () => {
    const tasks = Array.from({ length: MAX_RENDERED_TOASTS + 3 }, (_, i) => `t${i}`);
    const { rendered, hiddenCount } = selectRenderedToasts(tasks);
    expect(rendered).toHaveLength(MAX_RENDERED_TOASTS);
    expect(hiddenCount).toBe(3);
    // The newest toast is still the front card.
    expect(rendered.at(-1)).toBe(tasks.at(-1));
    expect(rendered).not.toContain("t0");
  });
});
