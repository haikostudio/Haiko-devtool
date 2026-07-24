import { useCallback, useRef } from "react";

/**
 * Marks a task "viewed" (which then dims a finished card to 50%) ONLY on a real
 * user interaction inside its open drawer/dock — a tap, or the touch that starts
 * a scroll — never on the mere programmatic opening of the surface.
 *
 * Returns props to spread on the drawer body's `<View>`:
 * `onStartShouldSetResponderCapture` fires on the capture phase of any touch (or
 * web mouse-down) that begins inside, then returns `false` so the touch still
 * reaches its real target (a button, a ScrollView) completely untouched — the
 * body observes the interaction without ever stealing it. It fires at most once
 * per task; the server stamp is idempotent regardless.
 */
export function useTaskViewedOnInteract(
  taskId: string | null,
  markViewed: (taskId: string) => void,
): { onStartShouldSetResponderCapture: () => boolean } {
  const firedForRef = useRef<string | null>(null);
  const onStartShouldSetResponderCapture = useCallback(() => {
    if (taskId && firedForRef.current !== taskId) {
      firedForRef.current = taskId;
      markViewed(taskId);
    }
    return false;
  }, [taskId, markViewed]);
  return { onStartShouldSetResponderCapture };
}
