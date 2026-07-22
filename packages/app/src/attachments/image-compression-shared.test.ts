import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_DIMENSION,
  fileNameForMimeType,
  isCompressibleImageMimeType,
  scaleToFitDimension,
} from "./image-compression-shared";

describe("isCompressibleImageMimeType", () => {
  it("accepts raster formats we can re-encode", () => {
    expect(isCompressibleImageMimeType("image/jpeg")).toBe(true);
    expect(isCompressibleImageMimeType("image/jpg")).toBe(true);
    expect(isCompressibleImageMimeType("image/PNG")).toBe(true);
    expect(isCompressibleImageMimeType("image/webp")).toBe(true);
  });

  it("rejects formats that must stay untouched", () => {
    expect(isCompressibleImageMimeType("image/gif")).toBe(false);
    expect(isCompressibleImageMimeType("image/svg+xml")).toBe(false);
    expect(isCompressibleImageMimeType("application/pdf")).toBe(false);
    expect(isCompressibleImageMimeType(null)).toBe(false);
    expect(isCompressibleImageMimeType(undefined)).toBe(false);
  });
});

describe("scaleToFitDimension", () => {
  it("returns null when the image already fits", () => {
    expect(scaleToFitDimension({ width: 800, height: 600 }, MAX_IMAGE_DIMENSION)).toBeNull();
    expect(
      scaleToFitDimension({ width: MAX_IMAGE_DIMENSION, height: 400 }, MAX_IMAGE_DIMENSION),
    ).toBeNull();
  });

  it("scales the longest edge down to the max and keeps aspect ratio", () => {
    const scaled = scaleToFitDimension({ width: 5710, height: 3552 }, 1568);
    expect(scaled).toEqual({ width: 1568, height: 975 });
  });

  it("scales portrait images by height", () => {
    const scaled = scaleToFitDimension({ width: 1179, height: 2556 }, 1568);
    expect(scaled).toEqual({ width: 723, height: 1568 });
  });

  it("never returns dimensions below 1px", () => {
    const scaled = scaleToFitDimension({ width: 10_000, height: 1 }, 1568);
    expect(scaled).toEqual({ width: 1568, height: 1 });
  });

  it("returns null for degenerate dimensions", () => {
    expect(scaleToFitDimension({ width: 0, height: 100 }, 1568)).toBeNull();
  });
});

describe("fileNameForMimeType", () => {
  it("replaces the extension to match the encoded format", () => {
    expect(fileNameForMimeType("screenshot.png", "image/jpeg")).toBe("screenshot.jpg");
    expect(fileNameForMimeType("photo.jpeg", "image/png")).toBe("photo.png");
  });

  it("keeps the name when there is no mapping or no file name", () => {
    expect(fileNameForMimeType("photo.webp", "image/webp")).toBe("photo.webp");
    expect(fileNameForMimeType(null, "image/jpeg")).toBeNull();
    expect(fileNameForMimeType(undefined, "image/jpeg")).toBeNull();
  });
});
