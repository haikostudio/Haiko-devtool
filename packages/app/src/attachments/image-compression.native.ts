import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
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
 * Downscales an image attachment before it is persisted, so the base64
 * payload later sent over the relay stays small. Returns null when the
 * attachment should be saved unchanged.
 *
 * Native only downscales oversized images (keeping PNG as PNG to preserve
 * transparency); images already within bounds are attached as-is.
 */
export async function maybeCompressImageAttachment(
  input: SaveAttachmentInput,
): Promise<SaveAttachmentInput | null> {
  if (input.source.kind !== "file_uri") {
    // Blobs/bytes/data URLs are rare on native (images arrive as picker or
    // camera file URIs); skip rather than round-trip through the filesystem.
    return null;
  }
  if (!isCompressibleImageMimeType(input.mimeType)) {
    return null;
  }

  const uri = input.source.uri;
  try {
    const byteSize = await fileByteSize(uri);
    if (byteSize !== null && byteSize <= IMAGE_COMPRESSION_BYTE_THRESHOLD) {
      return null;
    }

    const context = ImageManipulator.manipulate(uri);
    let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
    try {
      image = await context.renderAsync();
      const target = scaleToFitDimension(image, MAX_IMAGE_DIMENSION);
      if (!target) {
        return null;
      }

      image.release();
      image = null;

      context.resize(target);
      image = await context.renderAsync();

      const keepPng = input.mimeType?.toLowerCase() === "image/png";
      const outputMime = keepPng ? "image/png" : "image/jpeg";
      const result = await image.saveAsync({
        format: keepPng ? SaveFormat.PNG : SaveFormat.JPEG,
        compress: IMAGE_COMPRESSION_JPEG_QUALITY,
      });

      return {
        ...input,
        mimeType: outputMime,
        fileName: fileNameForMimeType(input.fileName, outputMime),
        source: { kind: "file_uri", uri: result.uri },
      };
    } finally {
      image?.release();
      context.release();
    }
  } catch (error) {
    console.warn("[attachments] Image compression failed; keeping original", { error });
    return null;
  }
}

async function fileByteSize(uri: string): Promise<number | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const size = (info as { size?: number }).size;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
}
