/**
 * Shared decision logic for compressing image attachments before they are
 * persisted (and later sent to the daemon as base64 over the relay, whose
 * WebSocket frames are size-limited).
 */

/**
 * Longest edge kept after downscaling. Claude vision downsizes anything above
 * ~1568px anyway, so larger images only cost bandwidth without adding detail.
 */
export const MAX_IMAGE_DIMENSION = 1568;

/** Sources at or below this byte size are attached unchanged. */
export const IMAGE_COMPRESSION_BYTE_THRESHOLD = 400_000;

export const IMAGE_COMPRESSION_JPEG_QUALITY = 0.85;

const COMPRESSIBLE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function isCompressibleImageMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return COMPRESSIBLE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Returns the dimensions scaled down to fit `maxDimension` on the longest
 * edge, or null when the image already fits (no upscaling, ever).
 */
export function scaleToFitDimension(
  dimensions: ImageDimensions,
  maxDimension: number,
): ImageDimensions | null {
  const { width, height } = dimensions;
  if (width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return null;
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Renames a file to match the re-encoded format, preserving the base name. */
export function fileNameForMimeType(
  fileName: string | null | undefined,
  mimeType: string,
): string | null {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!fileName || !extension) {
    return fileName ?? null;
  }
  return fileName.replace(/\.[^./\\]+$/, "") + `.${extension}`;
}
