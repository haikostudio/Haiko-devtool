import { useCallback, useEffect, useMemo } from "react";
import { type LayoutChangeEvent, useWindowDimensions, type ViewStyle } from "react-native";
import { usePathname } from "expo-router";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
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
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (!first) {
    return "index";
  }
  if (first === "h") {
    return "chat";
  }
  return first;
}

export interface DraggableToast {
  gesture: ReturnType<typeof Gesture.Pan>;
  animatedStyle: AnimatedStyle<ViewStyle>;
  onLayout: (event: LayoutChangeEvent) => void;
}

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
    const top0 = height - bottomOffset - h;
    minX.value = -left0;
    maxX.value = rightOffset;
    minY.value = -top0;
    maxY.value = bottomOffset;
    tx.value = Math.min(Math.max(tx.value, minX.value), maxX.value);
    ty.value = Math.min(Math.max(ty.value, minY.value), maxY.value);
  }, [width, height, rightOffset, bottomOffset, boxW, boxH, minX, maxX, minY, maxY, tx, ty]);

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

  const gesture = useMemo(
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
          runOnJS(setPosition)(key, { x: tx.value, y: ty.value });
        }),
    [key, setPosition, tx, ty, startX, startY, minX, maxX, minY, maxY],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
  }));

  return { gesture, animatedStyle, onLayout };
}
