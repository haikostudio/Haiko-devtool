import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_ROWS,
  ROW_GAP,
  ROW_HEIGHT,
  rowsAreaHeight,
  usesWideBoardGutter,
} from "@/components/tasks/task-gantt-layout";

describe("rowsAreaHeight", () => {
  it("keeps one lane when nothing is scheduled", () => {
    // The empty timeline still draws a placeholder row, so it must reserve the
    // height of exactly one row — never zero, which is what left a blank slab.
    expect(rowsAreaHeight(0)).toBe(ROW_HEIGHT);
  });

  it("matches a single row exactly", () => {
    expect(rowsAreaHeight(1)).toBe(ROW_HEIGHT);
  });

  it("grows one row at a time", () => {
    expect(rowsAreaHeight(5)).toBe(5 * ROW_HEIGHT + 4 * ROW_GAP);
    expect(rowsAreaHeight(5) - rowsAreaHeight(4)).toBe(ROW_HEIGHT + ROW_GAP);
  });

  it("stops growing past the visible-row cap, so extra rows scroll inside", () => {
    const capped = MAX_VISIBLE_ROWS * ROW_HEIGHT + (MAX_VISIBLE_ROWS - 1) * ROW_GAP;
    expect(rowsAreaHeight(MAX_VISIBLE_ROWS)).toBe(capped);
    expect(rowsAreaHeight(MAX_VISIBLE_ROWS + 1)).toBe(capped);
    expect(rowsAreaHeight(120)).toBe(capped);
  });

  it("never returns a negative height for nonsense input", () => {
    expect(rowsAreaHeight(-3)).toBe(ROW_HEIGHT);
  });
});

describe("usesWideBoardGutter", () => {
  // The test environment runs as web, which is where the desktop board's wide
  // inset applies. Compact always falls back to the tight gutter, on every
  // platform — the compact web board and the native scroller both inset by the
  // smaller token.
  it("uses the wide gutter only on the roomy web board", () => {
    expect(usesWideBoardGutter(false)).toBe(true);
  });

  it("uses the tight gutter whenever the layout is compact", () => {
    expect(usesWideBoardGutter(true)).toBe(false);
  });
});
