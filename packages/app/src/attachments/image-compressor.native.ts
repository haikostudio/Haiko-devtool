import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  base64Bytes,
  type CompressImageInput,
  type EncodedAttachment,
} from "@/attachments/image-compression";

/** Longest edge we scale down to on the first resize pass. */
const MAX_EDGE_PX = 1280;
const MIN_EDGE_PX = 320;
const MAX_ATTEMPTS = 8;
const MIN_QUALITY = 0.28;
const EDGE_SHRINK_RATIO = 0.72;

function resizeToLongestEdge(width: number, height: number, longestEdge: number) {
  const sourceLongestEdge = Math.max(width, height);
  if (sourceLongestEdge <= 0) return null;
  // Clamp the scale at 1 so we never upscale a source that is already small.
  const scale = Math.min(1, longestEdge / sourceLongestEdge);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Reads the source pixel dimensions without producing an encoded result, so the
 * compression loop can downscale-to-fit from the very first pass (mirroring the
 * web canvas path). Returns 0/0 if the probe fails; the caller then falls back to
 * re-encoding at the source size.
 */
async function probeSourceDimensions(url: string): Promise<{ width: number; height: number }> {
  const context = ImageManipulator.manipulate(url);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    image = await context.renderAsync();
    return { width: image.width, height: image.height };
  } catch (error) {
    console.warn("[attachments] Failed to probe native image dimensions", { error });
    return { width: 0, height: 0 };
  } finally {
    image?.release();
    context.release();
  }
}

/**
 * Native image compressor (expo-image-manipulator). It always caps the longest
 * edge at {@link MAX_EDGE_PX} (never upscaling), then re-encodes as JPEG at a
 * decreasing quality/size until the encoded byte length drops under `targetBytes`.
 * Capping the dimensions matters even when the byte size is already small: some
 * providers (Codex/OpenAI vision) reject high-resolution inputs that Claude would
 * accept. Returns the smallest result produced (best effort) even if the target is
 * not reached.
 */
export async function compressImage({
  url,
  targetBytes,
}: CompressImageInput): Promise<EncodedAttachment | null> {
  const { width: sourceWidth, height: sourceHeight } = await probeSourceDimensions(url);
  const knowSourceSize = sourceWidth > 0 && sourceHeight > 0;

  let best: EncodedAttachment | null = null;
  let targetLongestEdge = knowSourceSize
    ? Math.min(MAX_EDGE_PX, Math.max(sourceWidth, sourceHeight))
    : MAX_EDGE_PX;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const quality = Math.max(MIN_QUALITY, 0.8 - attempt * 0.08);
    const context = ImageManipulator.manipulate(url);
    // Resize down to the current target edge on every pass. When the source size is
    // unknown (probe failed) we recompress at the source resolution instead.
    const resized = knowSourceSize
      ? resizeToLongestEdge(sourceWidth, sourceHeight, targetLongestEdge)
      : null;
    if (resized) {
      context.resize(resized);
    }

    let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
    try {
      image = await context.renderAsync();
      const result = await image.saveAsync({
        format: SaveFormat.JPEG,
        compress: quality,
        base64: true,
      });
      const base64 = result.base64 ?? null;
      if (base64) {
        if (!best || base64.length < best.data.length) {
          best = { data: base64, mimeType: "image/jpeg" };
        }
        if (base64Bytes(base64) <= targetBytes) {
          return best;
        }
      }
    } catch (error) {
      console.warn("[attachments] Native compression attempt failed", { attempt, error });
    } finally {
      image?.release();
      context.release();
    }

    if (targetLongestEdge <= MIN_EDGE_PX) break;
    targetLongestEdge = Math.max(MIN_EDGE_PX, Math.round(targetLongestEdge * EDGE_SHRINK_RATIO));
  }

  return best;
}
