// Pure geometry for the floating agent-task toast pile (bottom-right corner).
//
// The pile renders top-to-bottom: the first rendered card sits deepest (furthest
// from the corner, mostly hidden behind the ones in front of it) and the last
// rendered card is the front card, nearest the corner and fully visible. "Depth"
// counts back from that front card: depth 0 is the front card, depth 1 is the one
// directly behind it, and so on.
//
// Keeping the math here (instead of inline in the component) means the fold
// offsets, the depth fade and the render cap are unit-testable without mounting
// a single view.

/**
 * Hard cap on how many cards are ever mounted. Past this the oldest toasts stop
 * being rendered — they stay tracked (and counted in the "show all" label) but
 * never grow the pile. Without a cap a busy corner stacks forever.
 */
export const MAX_RENDERED_TOASTS = 5;

/**
 * Breathing room between cards while the pile is open, and between the front card
 * and the controls row in both states. Owned here rather than by a flex `gap` on
 * the column: a gap would be *added* to every negative fold margin, quietly
 * inflating each peek and undoing the compaction.
 */
export const EXPANDED_GAP = 8;

// Sliver of the card at depth 1 that stays visible above the front card, and the
// factor each further step shrinks by. Degressive on purpose: the cards behind
// converge, so the pile's total height flattens out instead of growing linearly.
const PEEK_FIRST = 9;
const PEEK_DECAY = 0.6;
const PEEK_MIN = 3;

// Depth fade: the front card is fully lit and each card behind drops a step,
// floored so its status pip still reads against the background.
const OPACITY_STEP = 0.16;
const MIN_OPACITY = 0.4;

// Depth scale: a whisper of perspective. Deliberately tiny — the cards must read
// as the same width, so this only nudges the silhouette, it never resizes layout
// (transforms don't participate in layout).
const SCALE_STEP = 0.015;
const MIN_SCALE = 0.955;

/**
 * How much of the card at `depth` peeks out above the card in front of it, once
 * the pile is folded. Depth 0 (the front card) has nothing in front of it.
 */
export function collapsedPeek(depth: number): number {
  if (depth <= 0) {
    return 0;
  }
  return Math.max(PEEK_MIN, Math.round(PEEK_FIRST * PEEK_DECAY ** (depth - 1)));
}

export interface ToastStackSlot {
  /**
   * Bottom margin for this card: a positive gap while the pile is open, a
   * negative pull that slides the next card up over this one while it is folded.
   */
  overlap: number;
  /** Content fade for this card — 1 at the front, dimmer with depth. */
  opacity: number;
  /** Whole-card scale for this card — 1 at the front, slightly smaller behind. */
  scale: number;
  /** Stacking order: the front card always wins. */
  zIndex: number;
}

/**
 * Layout for one card in the pile. `cardHeight` is the card's measured natural
 * height; before it has been measured pass 0 and the card simply doesn't overlap
 * yet (it settles into place on the next layout pass).
 */
export function toastStackSlot(input: {
  depth: number;
  renderedCount: number;
  cardHeight: number;
  collapsed: boolean;
}): ToastStackSlot {
  const { depth, renderedCount, cardHeight, collapsed } = input;
  // Front card highest, so the pile reads as receding away from the corner.
  const zIndex = Math.max(renderedCount - depth, 0);

  // The front card never folds: its margin is the gap down to the controls row,
  // in both states, so the controls don't jump when the pile opens or closes.
  if (!collapsed || depth === 0) {
    return { overlap: EXPANDED_GAP, opacity: 1, scale: 1, zIndex };
  }

  // Hide everything but the sliver. Guarded so an unmeasured card yields a clean
  // 0 rather than -0.
  const hidden = Math.max(cardHeight - collapsedPeek(depth), 0);

  return {
    overlap: hidden === 0 ? 0 : -hidden,
    opacity: Math.max(1 - depth * OPACITY_STEP, MIN_OPACITY),
    scale: Math.max(1 - depth * SCALE_STEP, MIN_SCALE),
    zIndex,
  };
}

/**
 * Total height of the folded pile, given each card's natural height ordered
 * front-first (index = depth). Exists so the compaction is assertable in tests.
 */
export function collapsedStackHeight(heightsByDepth: readonly number[]): number {
  if (heightsByDepth.length === 0) {
    return 0;
  }
  let total = heightsByDepth[0] ?? 0;
  for (let depth = 1; depth < heightsByDepth.length; depth += 1) {
    total += collapsedPeek(depth);
  }
  return total;
}

export interface RenderedToasts<T> {
  /** The cards to mount, still in render order (deepest first, front last). */
  rendered: T[];
  /** How many tracked toasts were left out because of the cap. */
  hiddenCount: number;
}

/**
 * Trims the tracked list down to the cards actually worth mounting. `tasks` comes
 * in render order (oldest first / front last), so the cap keeps the tail: the most
 * recent toasts stay, the oldest quietly drop off the back of the pile.
 */
export function selectRenderedToasts<T>(
  tasks: readonly T[],
  max: number = MAX_RENDERED_TOASTS,
): RenderedToasts<T> {
  if (tasks.length <= max) {
    return { rendered: [...tasks], hiddenCount: 0 };
  }
  return { rendered: tasks.slice(tasks.length - max), hiddenCount: tasks.length - max };
}
