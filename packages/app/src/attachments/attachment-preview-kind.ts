import { getFileExtensionFromName } from "@/attachments/utils";

/**
 * How the attachments panel renders one library entry. `svg` is split out of
 * `image` because the native image view cannot rasterize SVG — that one goes
 * through the SVG renderer instead.
 */
export type AttachmentPreviewKind = "markdown" | "image" | "svg" | "pdf" | "unsupported";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);

/**
 * Extension first, MIME type second: the daemon indexes whatever the chat
 * carried, so a screenshot pasted as `application/octet-stream` still previews
 * when its name says `.png`, and a name-less entry still previews when its MIME
 * type is honest.
 */
export function resolveAttachmentPreviewKind(input: {
  fileName: string;
  mimeType?: string | null;
}): AttachmentPreviewKind {
  const extension = getFileExtensionFromName(input.fileName).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return "markdown";
  }
  if (extension === ".svg") {
    return "svg";
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (extension === ".pdf") {
    return "pdf";
  }

  const mimeType = (input.mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return "markdown";
  }
  if (mimeType === "image/svg+xml") {
    return "svg";
  }
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  // Only for extensions we did not recognize: a `.psd` served as `image/vnd.*`
  // would otherwise be handed to an image view that cannot decode it. Known web
  // image types only.
  if (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp" ||
    mimeType === "image/bmp" ||
    mimeType === "image/avif"
  ) {
    return "image";
  }
  return "unsupported";
}
