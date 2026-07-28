/**
 * Placement math for the draggable floating toast (pile + compact FAB).
 *
 * Pulled out of use-draggable-toast so the "never park under the side panel"
 * rules can be tested without a gesture. `minX`/`maxX` are the drag bounds for a
 * *bare* window; `rightInset` is the width currently reserved by an in-row side
 * panel (see use-floating-right-inset), which pushes the usable left bound to the
 * right by exactly that much — the element itself is drawn shifted left by the
 * same amount, so both edges stay visible.
 *
 * These run inside gesture worklets, hence the directives.
 */

export function floatingToastLeftBound(minX: number, rightInset: number): number {
  "worklet";
  // A panel wider than the whole drag range would invert the window; keep the
  // bound below maxX's responsibility here and let the caller clamp.
  return minX + rightInset;
}

export function clampFloatingToastX({
  x,
  minX,
  maxX,
  rightInset,
}: {
  x: number;
  minX: number;
  maxX: number;
  rightInset: number;
}): number {
  "worklet";
  const leftBound = floatingToastLeftBound(minX, rightInset);
  return Math.min(Math.max(x, Math.min(leftBound, maxX)), maxX);
}

/**
 * Light magnet applied on release: snap to whichever side edge is within
 * `threshold`, keeping `margin` of breathing room; otherwise stay put. The right
 * edge is the panel's left border when one is open, never the window's.
 */
export function resolveFloatingToastSnapX({
  x,
  minX,
  maxX,
  rightInset,
  threshold,
  margin,
}: {
  x: number;
  minX: number;
  maxX: number;
  rightInset: number;
  threshold: number;
  margin: number;
}): number {
  "worklet";
  const leftBound = Math.min(floatingToastLeftBound(minX, rightInset), maxX);
  const distLeft = x - leftBound;
  const distRight = maxX - x;
  const nearLeft = distLeft <= distRight;
  const nearestDist = nearLeft ? distLeft : distRight;
  if (nearestDist > threshold) {
    return x;
  }
  return nearLeft ? Math.min(leftBound + margin, maxX) : Math.max(maxX - margin, leftBound);
}
