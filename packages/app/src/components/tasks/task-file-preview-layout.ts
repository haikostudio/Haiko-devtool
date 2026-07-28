/** Open/close duration of the board's file preview panel, in ms. */
export const PREVIEW_ANIMATION_MS = 200;

/** Half the board area, the spec's width — clamped so it stays readable. */
const PREVIEW_WIDTH_RATIO = 0.5;
const MIN_PREVIEW_WIDTH = 320;

/**
 * Width the desktop preview overlay takes out of the area it floats over: half
 * of it, never so narrow that code wraps into noise. On a viewport smaller than
 * twice the floor the panel simply covers everything, which is the honest
 * outcome — there is no half worth reading at that size.
 */
export function resolveFilePreviewWidth(availableWidth: number): number {
  const half = Math.round(availableWidth * PREVIEW_WIDTH_RATIO);
  if (availableWidth <= MIN_PREVIEW_WIDTH) {
    return Math.max(0, availableWidth);
  }
  return Math.max(MIN_PREVIEW_WIDTH, half);
}
