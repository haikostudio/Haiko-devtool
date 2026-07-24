export interface CompactSheetSafeAreaPaddingInput {
  isCompact: boolean;
  hasFooter: boolean;
  baseContentPadding: number;
  baseFooterPadding: number;
  safeAreaBottom: number;
}

export interface CompactSheetSafeAreaPadding {
  contentPaddingBottom?: number;
  footerPaddingBottom?: number;
}

// Minimum gap kept under a compact footer's action buttons even when the
// platform reports no bottom inset. A PWA that isn't running standalone (or a
// browser that doesn't surface env(safe-area-inset-bottom)) reports a zero
// inset, which used to glue the Delete/Cancel/Save row to the screen edge.
const MIN_COMPACT_FOOTER_BOTTOM_GAP = 16;

export function getCompactSheetSafeAreaPadding({
  isCompact,
  hasFooter,
  baseContentPadding,
  baseFooterPadding,
  safeAreaBottom,
}: CompactSheetSafeAreaPaddingInput): CompactSheetSafeAreaPadding {
  if (!isCompact) {
    return {};
  }

  if (hasFooter) {
    // Grow with the real home-indicator inset when reported, but never let the
    // buttons sit flush against the edge.
    return {
      footerPaddingBottom:
        baseFooterPadding + Math.max(safeAreaBottom, MIN_COMPACT_FOOTER_BOTTOM_GAP),
    };
  }

  if (safeAreaBottom <= 0) {
    return {};
  }

  return { contentPaddingBottom: baseContentPadding + safeAreaBottom };
}
