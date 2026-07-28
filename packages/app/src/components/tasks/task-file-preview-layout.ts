/** Open/close duration of the board's file preview panel, in ms. */
export const PREVIEW_ANIMATION_MS = 200;

/** Half the board area — the width a preview opens at before the user drags it. */
const PREVIEW_WIDTH_RATIO = 0.5;
/** Narrower than this and code wraps into noise, so the drag stops here. */
export const MIN_FILE_PREVIEW_WIDTH = 320;
/**
 * Sentinel for "the user has never dragged this panel": the width then follows
 * the area it floats over instead of freezing at whatever a past viewport made
 * half of. Any dragged width is a positive number.
 */
export const FILE_PREVIEW_WIDTH_UNSET = 0;

/**
 * Width the desktop preview overlay takes out of the area it floats over.
 *
 * Untouched, it is half of that area. Once dragged it keeps the requested width,
 * clamped so it never gets unreadably narrow nor wider than the area itself. On
 * an area smaller than the floor the panel simply covers everything, which is
 * the honest outcome — there is no half worth reading at that size.
 *
 * Worklet-safe: the resize gesture clamps on the UI thread while dragging.
 */
export function resolveFilePreviewWidth(input: {
  requestedWidth: number;
  areaWidth: number;
}): number {
  "worklet";
  const areaWidth = Math.max(0, input.areaWidth);
  if (areaWidth <= MIN_FILE_PREVIEW_WIDTH) {
    return areaWidth;
  }
  const requested =
    input.requestedWidth > FILE_PREVIEW_WIDTH_UNSET
      ? input.requestedWidth
      : Math.round(areaWidth * PREVIEW_WIDTH_RATIO);
  return Math.max(MIN_FILE_PREVIEW_WIDTH, Math.min(areaWidth, Math.round(requested)));
}
