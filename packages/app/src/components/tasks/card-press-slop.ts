/**
 * Tells a real click apart from the tail of a drag.
 *
 * A board card is both draggable (dnd-kit owns the pointer stream) and
 * pressable (React Native Web's press responder fires on pointerup). Once a
 * card has travelled, the pointerup that ends the drag must not read as a tap —
 * otherwise dropping a folded lot would unfold it, or open the task underneath.
 *
 * The tracker is deliberately dumb and synchronous: record where the pointer
 * went down, measure how far it is on the way up, and answer one question —
 * should the press that is about to fire be swallowed?
 */

/** Same slop as the board's MouseSensor activation distance: below it, nothing drags. */
export const PRESS_SLOP_PX = 6;

export interface PressSlopTracker {
  /** Pointer went down at (x, y) — starts a fresh gesture. */
  down(x: number, y: number): void;
  /** Pointer came up at (x, y) — freezes the verdict for the press that follows. */
  up(x: number, y: number): void;
  /** The card entered a drag (dnd-kit took over); the gesture is no longer a tap. */
  markDragging(): void;
  /** True when the press that is firing right now is drag debris, not a tap. */
  shouldSuppressPress(): boolean;
}

export function createPressSlopTracker(slop: number = PRESS_SLOP_PX): PressSlopTracker {
  let originX = 0;
  let originY = 0;
  let dragged = false;
  let moved = false;
  return {
    down(x, y) {
      originX = x;
      originY = y;
      dragged = false;
      moved = false;
    },
    up(x, y) {
      moved = Math.hypot(x - originX, y - originY) > slop;
    },
    markDragging() {
      dragged = true;
    },
    shouldSuppressPress() {
      const suppress = dragged || moved;
      // One verdict per gesture: a swallowed press must not poison the next tap
      // if the pointerup that ends a drag never reaches the card.
      dragged = false;
      moved = false;
      return suppress;
    },
  };
}
