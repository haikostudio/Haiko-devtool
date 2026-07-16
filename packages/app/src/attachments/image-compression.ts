/**
 * Attachment send budget + image compression contract.
 *
 * Why this exists: outbound agent messages travel as a single WebSocket frame.
 * Over the E2EE relay the image `data` field is base64 (~1.33x the raw bytes),
 * the whole JSON message is then encrypted and re-encoded as base64 by the relay
 * channel (~1.33x again), so the final frame is roughly 1.77x the raw image bytes.
 * Cloudflare closes any WebSocket frame over ~1 MiB with close code 1009
 * ("message too big"), which tears down the whole transport. A large screenshot
 * attachment therefore used to kill the session on send.
 *
 * The fix has two parts, both driven from here:
 *  1. Compress oversized images down to a byte target before encoding.
 *  2. Hard budget guard — if the encoded attachments still exceed the budget,
 *     throw {@link AttachmentTooLargeError} instead of sending, so the frame is
 *     never emitted and the socket survives.
 *
 * Budgets are expressed in base64 characters because that is exactly what lands
 * in the JSON payload. 640k base64 chars ≈ 470 KB of JSON, which stays well under
 * 1 MiB after encryption + relay base64 wrapping, leaving room for the message text.
 */

export interface EncodedAttachment {
  data: string;
  mimeType: string;
}

/** Total base64 characters allowed across all attachments in one message. */
export const MAX_TOTAL_ATTACHMENT_BASE64_CHARS = 640_000;

/** Above this per-image base64 length we attempt compression before sending. */
export const IMAGE_COMPRESS_TRIGGER_BASE64_CHARS = 480_000;

/** Byte target the compressor aims for per image (base64 of this stays comfortably under budget). */
export const IMAGE_COMPRESS_TARGET_BYTES = 320_000;

export interface CompressImageInput {
  /** Loadable URL for the source image (blob: URL on web, file:// URI on native). */
  url: string;
  mimeType: string;
  /** Target encoded size in bytes; the compressor aims at or below this. */
  targetBytes: number;
}

/** Compresses an image to (at best) `targetBytes`. Returns null if it cannot compress. */
export type ImageCompressor = (input: CompressImageInput) => Promise<EncodedAttachment | null>;

export class AttachmentTooLargeError extends Error {
  readonly totalChars: number;
  readonly limitChars: number;

  constructor(totalChars: number, limitChars: number) {
    super("Attachment is too large to send even after compression. Please attach a smaller image.");
    this.name = "AttachmentTooLargeError";
    this.totalChars = totalChars;
    this.limitChars = limitChars;
  }
}

/** How many raw bytes a base64 budget of `chars` characters can hold (~3/4 ratio). */
function base64CharsToBytes(chars: number): number {
  return Math.floor((chars * 3) / 4);
}

/** Approximate decoded byte length of a base64 string (ignoring any data-URL prefix). */
export function base64Bytes(base64: string): number {
  const comma = base64.indexOf(",");
  const body =
    comma >= 0 && base64.slice(0, comma).includes(";base64") ? base64.slice(comma + 1) : base64;
  const len = body.length;
  if (len === 0) return 0;
  let padding = 0;
  if (body.endsWith("==")) padding = 2;
  else if (body.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Whether an image mime type can be safely re-encoded as JPEG. We skip vector
 * (svg) and animated (gif) formats because JPEG re-encoding would destroy them.
 */
export function isCompressibleImage(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  if (!type.startsWith("image/")) return false;
  return type !== "image/gif" && type !== "image/svg+xml";
}

export interface EncodeBudgetDeps {
  encodeBase64: (attachmentId: string) => Promise<string>;
  resolvePreviewUrl: (attachmentId: string) => Promise<string>;
  releasePreviewUrl?: (attachmentId: string, url: string) => Promise<void>;
  compress: ImageCompressor;
}

export interface BudgetAttachment {
  id: string;
  mimeType: string;
}

interface BudgetEntry extends EncodedAttachment {
  id: string;
  compressible: boolean;
}

const totalChars = (entries: readonly BudgetEntry[]): number =>
  entries.reduce((sum, entry) => sum + entry.data.length, 0);

/**
 * Compresses one entry toward `targetBytes` in place, keeping the result only if
 * it is actually smaller. Preview URL is always released. Failures are logged and
 * leave the entry untouched. Returns whether the entry shrank.
 */
async function compressEntry(
  entry: BudgetEntry,
  targetBytes: number,
  deps: EncodeBudgetDeps,
): Promise<boolean> {
  const url = await deps.resolvePreviewUrl(entry.id);
  try {
    const compressed = await deps.compress({ url, mimeType: entry.mimeType, targetBytes });
    if (compressed && compressed.data.length < entry.data.length) {
      entry.data = compressed.data;
      entry.mimeType = compressed.mimeType;
      return true;
    }
    return false;
  } catch (error) {
    console.warn("[attachments] Image compression failed; sending original", {
      id: entry.id,
      error,
    });
    return false;
  } finally {
    await deps.releasePreviewUrl?.(entry.id, url);
  }
}

/**
 * Encodes attachments to base64 and guarantees the total stays under the send
 * budget so an oversized frame is never emitted (which would kill the socket).
 *
 * Strategy — the goal is that the user never hits a hard "too large" wall for
 * ordinary (compressible) screenshots, no matter how many they attach:
 *  1. Proactively compress any single image over the per-image trigger toward the
 *     comfortable per-image target, to keep frames small even when they'd fit.
 *  2. If the total still exceeds the budget, split the budget evenly across the
 *     compressible images and drive each below its share, repeating until the sum
 *     fits. Equal shares guarantee the sum lands under budget once every oversized
 *     image reaches its share — the compressor can hit far smaller targets than any
 *     realistic share, so this converges in one or two passes.
 *
 * Only genuinely incompressible content (gif/svg) that alone exceeds the budget
 * can still trip {@link AttachmentTooLargeError} — unreachable for jpeg/png/webp
 * screenshots. Per-attachment encode failures are logged and skipped.
 */
export async function encodeAttachmentsToBudget(
  attachments: readonly BudgetAttachment[],
  deps: EncodeBudgetDeps,
): Promise<EncodedAttachment[]> {
  const entries: BudgetEntry[] = [];

  for (const attachment of attachments) {
    let data: string;
    try {
      data = await deps.encodeBase64(attachment.id);
    } catch (error) {
      console.error("[attachments] Failed to encode attachment for send", {
        id: attachment.id,
        error,
      });
      continue;
    }
    entries.push({
      id: attachment.id,
      data,
      mimeType: attachment.mimeType,
      compressible: isCompressibleImage(attachment.mimeType),
    });
  }

  // 1. Proactive per-image compression for anything over the trigger.
  for (const entry of entries) {
    if (entry.compressible && entry.data.length > IMAGE_COMPRESS_TRIGGER_BASE64_CHARS) {
      await compressEntry(entry, IMAGE_COMPRESS_TARGET_BYTES, deps);
    }
  }

  // 2. Distribute the budget across compressible images until the sum fits.
  const MAX_BUDGET_PASSES = 4;
  for (let pass = 0; pass < MAX_BUDGET_PASSES; pass++) {
    if (totalChars(entries) <= MAX_TOTAL_ATTACHMENT_BASE64_CHARS) break;

    const compressibles = entries.filter((entry) => entry.compressible);
    if (compressibles.length === 0) break;

    const fixedChars = entries
      .filter((entry) => !entry.compressible)
      .reduce((sum, entry) => sum + entry.data.length, 0);
    const shareChars = Math.floor(
      Math.max(0, MAX_TOTAL_ATTACHMENT_BASE64_CHARS - fixedChars) / compressibles.length,
    );
    const shareBytes = Math.max(1, base64CharsToBytes(shareChars));

    let shrankAny = false;
    for (const entry of compressibles) {
      if (entry.data.length <= shareChars) continue;
      if (await compressEntry(entry, shareBytes, deps)) shrankAny = true;
    }
    // Compressor made no further progress — stop before looping forever.
    if (!shrankAny) break;
  }

  const total = totalChars(entries);
  if (total > MAX_TOTAL_ATTACHMENT_BASE64_CHARS) {
    throw new AttachmentTooLargeError(total, MAX_TOTAL_ATTACHMENT_BASE64_CHARS);
  }

  return entries.map(({ data, mimeType }) => ({ data, mimeType }));
}
