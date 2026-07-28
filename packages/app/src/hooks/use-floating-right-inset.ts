import { useEffect } from "react";
import { makeMutable, useAnimatedReaction, type SharedValue } from "react-native-reanimated";

/**
 * How much of the window's right edge is currently occupied by in-row side panels
 * — today the tasks board's file explorer and its conductor (agent) column.
 *
 * Floating overlays — the agent-tasks toast pile above all — are mounted at the
 * app root, so they are positioned against the *window*, not against the pane
 * they visually belong to. Without this reservation the pile parks itself on top
 * of the conductor column as soon as that column is open.
 *
 * It is a module-level shared value (same trick as synced-loader's clock) rather
 * than React state on purpose: a panel's width is written on every frame while
 * its edge is dragged, so the overlay has to follow it on the UI thread. A store
 * update per frame would re-render the whole pile and stutter the drag.
 *
 * Contract: each publisher owns one slot and clears it on unmount, so a consumer
 * never has to know which panels exist — it only reads the total.
 */

/**
 * The panels that may reserve room. A closed (unmounted) panel leaves its slot at
 * 0. Add a slot here — and to `recomputeTotal` — when a new right-hand panel
 * appears; the sum has to stay a worklet, so it can't loop over a dynamic map.
 */
const slots = {
  tasksExplorer: makeMutable(0),
  tasksConductor: makeMutable(0),
} as const;

export type FloatingRightInsetSlot = keyof typeof slots;

const total = makeMutable(0);

function recomputeTotal(): void {
  "worklet";
  total.value = slots.tasksExplorer.value + slots.tasksConductor.value;
}

/**
 * Read side: the live width reserved on the right edge, in pixels. 0 when no
 * panel is open. Safe to read from a worklet.
 */
export function useFloatingRightInset(): SharedValue<number> {
  return total;
}

/**
 * Write side: mirrors a panel's live (animated) width into its slot while
 * `enabled`, and clears the slot when the panel closes or unmounts.
 */
export function useReserveFloatingRightInset(
  slot: FloatingRightInsetSlot,
  width: SharedValue<number>,
  enabled: boolean,
): void {
  const target = slots[slot];

  useAnimatedReaction(
    () => (enabled ? width.value : 0),
    (next) => {
      target.value = next;
      recomputeTotal();
    },
    [enabled],
  );

  useEffect(() => {
    // Seed immediately: the reaction above only settles on the next frame, and a
    // panel that mounts already open would leave the pile overlapping until the
    // first resize. `recomputeTotal` is a worklet, but a worklet is still a plain
    // function — calling it from here just runs the same sum on the JS thread.
    target.value = enabled ? width.value : 0;
    recomputeTotal();
    return () => {
      target.value = 0;
      recomputeTotal();
    };
  }, [enabled, width, target]);
}
