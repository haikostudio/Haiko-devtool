/**
 * Native has no embedded PDF renderer in this app's dependency set, so the
 * preview pane falls back to "open it with the system viewer" instead. Web gets
 * the browser's own viewer — see `attachment-pdf-view.web.tsx`.
 */
export const SUPPORTS_EMBEDDED_PDF = false;

export interface AttachmentPdfViewProps {
  base64: string;
  mimeType: string;
  fileName: string;
}

export function AttachmentPdfView(_props: AttachmentPdfViewProps) {
  return null;
}
