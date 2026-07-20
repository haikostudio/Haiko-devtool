import { useCallback, useEffect, useMemo, useRef } from "react";
import { type LayoutChangeEvent, useWindowDimensions, type ViewStyle } from "react-native";
import { usePathname } from "expo-router";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
} from "react-native-reanimated";
import { useAgentTaskToastStore } from "@/stores/agent-task-toast-store";

// A drag doesn't start until the finger travels this far, so a plain tap on the
// button (to open the drawer) still registers instead of being eaten as a drag.
const DRAG_ACTIVATION_DISTANCE = 6;

// The floating agent-tasks button/pile remembers a separate position for each
// app "section", so its spot in the chat view is independent from its spot in the
// tasks board. We key the saved position by the top-level route: everything under
// a host (chat, workspace, agent…) collapses to one "chat" bucket, and other
// top-level routes (tasks, dashboard…) keep their own bucket.
export function useToastSection(): string {
  const pathname = usePathname();
  const first = pathname.split("/").find(Boolean);
  if (!first) {
    return "index";
  }
  if (first === "h") {
    return "chat";
  }
  return first;
}

export interface DraggableToast {
  gesture: ReturnType<typeof Gesture.Race>;
  animatedStyle: AnimatedStyle<ViewStyle>;
  onLayout: (event: LayoutChangeEvent) => void;
}

// How long the snap-to-edge / reset glides take — quick but readable as motion.
const SETTLE_DURATION_MS = 200;
// The magnet only pulls the button in when it's released within this distance of a
// side edge. Dropped further out, it stays exactly where the user put it — the
// magnet assists the "park it neatly" case without hijacking free placement.
const SNAP_THRESHOLD = 72;
// Minimum breathing room kept between the button and the very screen edge when it
// snaps, so it never sits flush against (or clipped by) the border.
const EDGE_MARGIN = 12;

// Makes an absolutely-positioned floating element freely draggable and remembers
// where the user parked it (per placement key). `rightOffset`/`bottomOffset` are
// the element's default distances from the screen's bottom-right corner; we use
// them, plus the element's measured size, to clamp the drag so it can never be
// pushed off-screen.
export function useDraggableToast({
  placement,
  section,
  rightOffset,
  bottomOffset,
}: {
  placement: string;
  section: string;
  rightOffset: number;
  bottomOffset: number;
}): DraggableToast {
  const { width, height } = useWindowDimensions();
  // The on-screen keyboard shrinks the window height (Android adjustResize, web
  // visualViewport). If we clamped the parked position to that shrunken height,
  // a button the user dragged upward would get yanked back down and lose its
  // spot every time the keyboard opened. So we track the tallest height we've
  // seen at the current width and clamp against that stable viewport instead —
  // the keyboard no longer moves the button. A real rotation changes the width,
  // which resets the remembered height so orientation still clamps correctly.
  const stableHeightRef = useRef(height);
  const lastWidthRef = useRef(width);
  if (lastWidthRef.current !== width) {
    lastWidthRef.current = width;
    stableHeightRef.current = height;
  } else if (height > stableHeightRef.current) {
    stableHeightRef.current = height;
  }
  const stableHeight = stableHeightRef.current;
  const key = `${placement}:${section}`;
  const persisted = useAgentTaskToastStore((state) => state.positions[key]);
  const setPosition = useAgentTaskToastStore((state) => state.setPosition);

  const tx = useSharedValue(persisted?.x ?? 0);
  const ty = useSharedValue(persisted?.y ?? 0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const minX = useSharedValue(0);
  const maxX = useSharedValue(0);
  const minY = useSharedValue(0);
  const maxY = useSharedValue(0);
  const boxW = useSharedValue(0);
  const boxH = useSharedValue(0);

  // Re-seed from the saved spot whenever the placement/section (i.e. the key)
  // changes or the stored value updates — e.g. navigating between sections.
  useEffect(() => {
    tx.value = persisted?.x ?? 0;
    ty.value = persisted?.y ?? 0;
  }, [persisted, tx, ty]);

  // Recompute the clamp window from the measured box + viewport, then pull the
  // current position back inside it (so a rotate/resize can't strand the button
  // off-screen). Safe to read shared values here — this runs on the JS thread.
  const recomputeBounds = useCallback(() => {
    const w = boxW.value;
    const h = boxH.value;
    if (w === 0 || h === 0) {
      return;
    }
    const left0 = width - rightOffset - w;
    const top0 = stableHeight - bottomOffset - h;
    minX.value = -left0;
    maxX.value = rightOffset;
    // Keep EDGE_MARGIN of breathing room top and bottom so a downward (or upward)
    // drag can never park the pile flush against the window edge — the horizontal
    // magnet already guarantees the same gap on the sides.
    minY.value = -top0 + EDGE_MARGIN;
    maxY.value = bottomOffset - EDGE_MARGIN;
    tx.value = Math.min(Math.max(tx.value, minX.value), maxX.value);
    ty.value = Math.min(Math.max(ty.value, minY.value), maxY.value);
  }, [width, stableHeight, rightOffset, bottomOffset, boxW, boxH, minX, maxX, minY, maxY, tx, ty]);

  useEffect(() => {
    recomputeBounds();
  }, [recomputeBounds]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      boxW.value = event.nativeEvent.layout.width;
      boxH.value = event.nativeEvent.layout.height;
      recomputeBounds();
    },
    [boxW, boxH, recomputeBounds],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(DRAG_ACTIVATION_DISTANCE)
        .onStart(() => {
          startX.value = tx.value;
          startY.value = ty.value;
        })
        .onUpdate((event) => {
          tx.value = Math.min(Math.max(startX.value + event.translationX, minX.value), maxX.value);
          ty.value = Math.min(Math.max(startY.value + event.translationY, minY.value), maxY.value);
        })
        .onEnd(() => {
          // Light magnet: if released close to a side edge, glide to it (keeping a
          // margin); if dropped further out than SNAP_THRESHOLD, stay put so free
          // placement wins. Vertical always stays where it was dropped.
          const distLeft = tx.value - minX.value;
          const distRight = maxX.value - tx.value;
          const nearLeft = distLeft <= distRight;
          const nearestDist = nearLeft ? distLeft : distRight;
          let targetX = tx.value;
          if (nearestDist <= SNAP_THRESHOLD) {
            targetX = nearLeft
              ? Math.min(minX.value + EDGE_MARGIN, maxX.value)
              : Math.max(maxX.value - EDGE_MARGIN, minX.value);
          }
          tx.value = withTiming(targetX, { duration: SETTLE_DURATION_MS });
          runOnJS(setPosition)(key, { x: targetX, y: ty.value });
        }),
    [key, setPosition, tx, ty, startX, startY, minX, maxX, minY, maxY],
  );

  // Long-press sends the button back to its default corner (offset 0,0). A press
  // (not a quick tap) so it never steals the button's tap-to-open, and a drag —
  // which needs movement first — always wins the race before the press fires.
  const reset = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
          tx.value = withTiming(0, { duration: SETTLE_DURATION_MS });
          ty.value = withTiming(0, { duration: SETTLE_DURATION_MS });
          runOnJS(setPosition)(key, { x: 0, y: 0 });
        }),
    [key, setPosition, tx, ty],
  );

  const gesture = useMemo(() => Gesture.Race(reset, pan), [reset, pan]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
  }));

  return { gesture, animatedStyle, onLayout };
}
