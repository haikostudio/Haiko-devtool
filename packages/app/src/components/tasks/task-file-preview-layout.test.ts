import { describe, expect, it } from "vitest";
import { resolveFilePreviewWidth } from "@/components/tasks/task-file-preview-layout";

describe("resolveFilePreviewWidth", () => {
  it("takes half of the area it floats over", () => {
    expect(resolveFilePreviewWidth(1200)).toBe(600);
    expect(resolveFilePreviewWidth(1441)).toBe(721);
  });

  it("never goes below the readable floor while a half would be narrower", () => {
    expect(resolveFilePreviewWidth(600)).toBe(320);
  });

  it("covers the whole area when even the floor does not fit", () => {
    expect(resolveFilePreviewWidth(280)).toBe(280);
    expect(resolveFilePreviewWidth(0)).toBe(0);
  });
});
