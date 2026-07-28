import { useEffect, useMemo } from "react";
import { Buffer } from "buffer";

/**
 * The browser ships a PDF viewer with page navigation, zoom and printing — we
 * embed that rather than bundling a renderer.
 */
export const SUPPORTS_EMBEDDED_PDF = true;

const FRAME_STYLE = {
  border: "none",
  width: "100%",
  height: "100%",
  display: "block",
} as const;

export interface AttachmentPdfViewProps {
  base64: string;
  mimeType: string;
  fileName: string;
}

/**
 * `<object>` rather than an iframe: the viewer needs both scripts and its own
 * origin (Firefox renders PDFs with pdf.js), a combination no sandbox attribute
 * can express — and an unsandboxed iframe is what the linter rightly refuses.
 *
 * Blob URL rather than the `data:` URL the rest of the previews use: browsers
 * refuse to load a `data:` document into a frame, so it would render blank.
 */
export function AttachmentPdfView({ base64, mimeType, fileName }: AttachmentPdfViewProps) {
  const url = useMemo(() => {
    const bytes = Buffer.from(base64, "base64");
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/pdf" }));
  }, [base64, mimeType]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return (
    <object
      data={url}
      type="application/pdf"
      aria-label={fileName}
      style={FRAME_STYLE}
      data-testid="attachment-pdf-frame"
    >
      {/* Shown only when the browser has no PDF viewer at all — mobile Safari,
          mostly. The panel's download button stays available beside it. */}
      <a href={url} download={fileName}>
        {fileName}
      </a>
    </object>
  );
}
