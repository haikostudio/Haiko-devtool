/**
 * Human-readable byte size (e.g. `12 B`, `3.4 KB`, `1.2 MB`). Shared by the file
 * pane and the attachment library so both read the same.
 */
export function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
