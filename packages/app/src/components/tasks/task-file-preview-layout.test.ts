import { describe, expect, it } from "vitest";
import {
  FILE_PREVIEW_WIDTH_UNSET,
  resolveFilePreviewWidth,
} from "@/components/tasks/task-file-preview-layout";

const UNSET = FILE_PREVIEW_WIDTH_UNSET;

describe("resolveFilePreviewWidth", () => {
  it("opens at half the area it floats over until the user drags it", () => {
    expect(resolveFilePreviewWidth({ requestedWidth: UNSET, areaWidth: 1200 })).toBe(600);
    expect(resolveFilePreviewWidth({ requestedWidth: UNSET, areaWidth: 1441 })).toBe(721);
  });

  it("keeps the width the user dragged to", () => {
    expect(resolveFilePreviewWidth({ requestedWidth: 900, areaWidth: 1600 })).toBe(900);
  });

  it("never goes below the readable floor, dragged or not", () => {
    expect(resolveFilePreviewWidth({ requestedWidth: 120, areaWidth: 1600 })).toBe(320);
    expect(resolveFilePreviewWidth({ requestedWidth: UNSET, areaWidth: 600 })).toBe(320);
  });

  it("never grows past the area it floats over", () => {
    expect(resolveFilePreviewWidth({ requestedWidth: 2000, areaWidth: 900 })).toBe(900);
  });

  it("covers the whole area when even the floor does not fit", () => {
    expect(resolveFilePreviewWidth({ requestedWidth: 800, areaWidth: 280 })).toBe(280);
    expect(resolveFilePreviewWidth({ requestedWidth: UNSET, areaWidth: 0 })).toBe(0);
  });

  it("re-clamps a stored width that no longer fits a smaller board", () => {
    // Dragged wide on a large screen, then reopened in a narrow one.
    expect(resolveFilePreviewWidth({ requestedWidth: 1100, areaWidth: 700 })).toBe(700);
  });
});
