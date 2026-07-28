import { HEADER_INNER_HEIGHT_MOBILE, HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";

/**
 * Compact geometry for the task board drawers (conductor chat, task details,
 * explorer). The sheet takes every pixel below the app header instead of a
 * fraction of the screen: `MOBILE_DOCK_TOP_GAP` is handed to the sheet as extra
 * top inset (stacked on the safe area), and gorhom measures its container as
 * `screen - topInset`, so a single `"100%"` snap point lands exactly under the
 * header row (Paseo / project / bell) with the status bar untouched.
 */
export const MOBILE_DOCK_TOP_GAP = HEADER_TOP_PADDING_MOBILE + HEADER_INNER_HEIGHT_MOBILE;

/** Single snap point: the full container, i.e. everything below the header. */
export const MOBILE_DOCK_SNAP_POINTS = ["100%"];

/**
 * Visible height the drawer occupies at its top position, for a given viewport.
 * Pure mirror of the sheet math above — exists so the "nearly full screen"
 * promise is asserted by a test rather than by reading two constants.
 */
export function mobileDockVisibleHeight({
  screenHeight,
  safeAreaTop,
}: {
  screenHeight: number;
  safeAreaTop: number;
}): number {
  return Math.max(0, screenHeight - safeAreaTop - MOBILE_DOCK_TOP_GAP);
}
