import { isWeb } from "@/constants/platform";
import { SPACING } from "@/styles/theme";

/**
 * Whether the board below uses the wide gutter, so the timeline panel and the
 * billing total can line up with the columns exactly.
 *
 * Two board implementations, two rules: the web board (kanban-board.web.tsx)
 * insets by spacing[4] on desktop and spacing[3] when compact, while the
 * native/compact scroller (kanban-board-scrollable.tsx) always insets by
 * spacing[3]. Anything sitting above the columns has to follow the same rule
 * or the block edges drift apart.
 */
export function usesWideBoardGutter(isCompact: boolean): boolean {
  return isWeb && !isCompact;
}

/**
 * Row metrics for the timeline panel, shared by its styles and by the height
 * computation. The panel is sized from its content — row count × row height —
 * instead of a fixed strip height, so an empty schedule is a thin band and a
 * busy one grows with the work, up to MAX_VISIBLE_ROWS. Past that the rows
 * block scrolls inside rather than pushing the kanban further down.
 */
export const ROW_TRACK_HEIGHT = 20;
export const ROW_VERTICAL_PADDING = SPACING[1];
export const ROW_HEIGHT = ROW_TRACK_HEIGHT + ROW_VERTICAL_PADDING * 2;
export const ROW_GAP = SPACING[1];
export const AXIS_HEIGHT = 18;
export const MAX_VISIBLE_ROWS = 10;

/**
 * Height of the rows block for a given row count, clamped to one row minimum
 * (an empty timeline still shows its lane, so the axis keeps a reference line)
 * and MAX_VISIBLE_ROWS maximum.
 */
export function rowsAreaHeight(rowCount: number): number {
  const visible = Math.min(Math.max(rowCount, 1), MAX_VISIBLE_ROWS);
  return visible * ROW_HEIGHT + (visible - 1) * ROW_GAP;
}
