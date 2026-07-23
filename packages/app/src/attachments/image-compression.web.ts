import type { SaveAttachmentInput } from "@/attachments/types";
import {
  IMAGE_COMPRESSION_BYTE_THRESHOLD,
  IMAGE_COMPRESSION_JPEG_QUALITY,
  MAX_IMAGE_DIMENSION,
  fileNameForMimeType,
  isCompressibleImageMimeType,
  scaleToFitDimension,
} from "@/attachments/image-compression-shared";

/**
 * Downscales/re-encodes an image attachment before it is persisted, so the
 * base64 payload later sent over the relay stays small. Returns null when the
 * attachment should be saved unchanged (not an image, already small, decode
 * failure, or compression would not shrink it).
 */
export async function maybeCompressImageAttachment(
  input: SaveAttachmentInput,
): Promise<SaveAttachmentInput | null> {
  try {
    const blob = await blobFromSource(input);
    if (!blob) return null;

    const mimeType = input.mimeType ?? (blob.type || null);
    if (!isCompressibleImageMimeType(mimeType)) return null;
    if (blob.size <= IMAGE_COMPRESSION_BYTE_THRESHOLD) return null;

    const bitmap = await createImageBitmap(blob);
    try {
      const target = scaleToFitDimension(bitmap, MAX_IMAGE_DIMENSION) ?? {
        width: bitmap.width,
        height: bitmap.height,
      };

      // A large JPEG already within bounds won't shrink meaningfully by
      // re-encoding at similar quality; only PNG/WebP benefit in that case.
      const needsDownscale = target.width !== bitmap.width || target.height !== bitmap.height;
      const normalizedMime = mimeType?.toLowerCase();
      if (!needsDownscale && (normalizedMime === "image/jpeg" || normalizedMime === "image/jpg")) {
        return null;
      }

      const drawn = drawToCanvas(bitmap, target.width, target.height);
      if (!drawn) return null;

      // Keep PNG when the image actually uses transparency; JPEG otherwise.
      const outputMime = drawn.hasAlpha ? "image/png" : "image/jpeg";
      const compressed = await canvasToBlob(drawn.canvas, outputMime);
      if (!compressed || compressed.size >= blob.size) return null;

      return {
        ...input,
        mimeType: outputMime,
        fileName: fileNameForMimeType(input.fileName, outputMime),
        source: { kind: "blob", blob: compressed },
      };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.warn("[attachments] Image compression failed; keeping original", { error });
    return null;
  }
}

async function blobFromSource(input: SaveAttachmentInput): Promise<Blob | null> {
  const { source } = input;
  if (source.kind === "blob") {
    return source.blob;
  }
  if (source.kind === "bytes") {
    const copy = new Uint8Array(source.bytes);
    return new Blob([copy.buffer], { type: input.mimeType ?? "" });
  }
  if (source.kind === "data_url") {
    const response = await fetch(source.dataUrl);
    if (!response.ok) return null;
    return await response.blob();
  }
  // file_uri: absolute paths (desktop dialog picks) are read by the desktop
  // attachment store through the Electron bridge; not readable here.
  return null;
}

interface DrawnCanvas {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  hasAlpha: boolean;
}

function drawToCanvas(bitmap: ImageBitmap, width: number, height: number): DrawnCanvas | null {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : createDomCanvas(width, height);
  if (!canvas) return null;

  const context = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) return null;

  context.drawImage(bitmap, 0, 0, width, height);
  return { canvas, hasAlpha: imageDataHasAlpha(context.getImageData(0, 0, width, height)) };
}

function createDomCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function imageDataHasAlpha(imageData: ImageData): boolean {
  const { data } = imageData;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    return await canvas.convertToBlob({
      type: mimeType,
      quality: IMAGE_COMPRESSION_JPEG_QUALITY,
    });
  }
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, IMAGE_COMPRESSION_JPEG_QUALITY);
  });
}
