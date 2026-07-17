import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { StreamMagicScrollbarProps } from "./magic-scrollbar-types";

const RAIL_WIDTH = 20;
// Inner padding so dots stay inside the track's rounded caps.
const RAIL_INSET_VERTICAL = 10;
const DOT_HIT_SIZE = 16;
const MIN_DOT_SPACING_PX = 18;
const HIDE_TRANSLATE_X = 48;
const TOOLTIP_DOT_ALIGN_OFFSET_PX = 14;

// Static positioning lives in a plain RN StyleSheet: Unistyles-managed styles
// must not be applied to a Reanimated Animated.View (see docs/unistyles.md).
const positionStyles = RNStyleSheet.create({
  container: {
    position: "absolute",
    top: 12,
    bottom: 12,
    right: 12,
    width: RAIL_WIDTH,
  },
  ping: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});

// Diffuse radar sweep behind the active dot: two soft, low-opacity rings
// expanding continuously and out of phase, so it reads as a breathing radar
// rather than a single blink. Transform/opacity live on the Animated.Views; the
// theme color lives on the inner Unistyles Views.
const PING_MAX_SCALE = 3.4;
const PING_PEAK_OPACITY = 0.28;

function ActiveDotPing() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = 0;
    pulse.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.out(Easing.ease) }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(pulse);
    };
  }, [pulse]);
  // Leading ring.
  const ring1Style = useAnimatedStyle(() => ({
    opacity: PING_PEAK_OPACITY * (1 - pulse.value),
    transform: [{ scale: 0.4 + pulse.value * PING_MAX_SCALE }],
  }));
  // Trailing ring, half a cycle behind, for a continuous sweep.
  const ring2Style = useAnimatedStyle(() => {
    const p = (pulse.value + 0.5) % 1;
    return {
      opacity: PING_PEAK_OPACITY * (1 - p),
      transform: [{ scale: 0.4 + p * PING_MAX_SCALE }],
    };
  });
  const ring1 = useMemo(() => [positionStyles.ping, ring1Style], [ring1Style]);
  const ring2 = useMemo(() => [positionStyles.ping, ring2Style], [ring2Style]);
  return (
    <>
      <Animated.View style={ring1} pointerEvents="none">
        <View style={styles.pingFill} />
      </Animated.View>
      <Animated.View style={ring2} pointerEvents="none">
        <View style={styles.pingFill} />
      </Animated.View>
    </>
  );
}

interface MagicScrollbarDotProps {
  entryId: string;
  label: string;
  top: number;
  isHovered: boolean;
  isActive: boolean;
  showPing: boolean;
  testID: string;
  onHoverChange: (entryId: string, hovered: boolean) => void;
  onJump: (entryId: string) => void;
}

// Hover lives on the plain outer View; press lives on the separate inner
// Pressable (docs/hover.md). The dot grows inside its fixed hit box, so hover
// never changes the trigger's geometry.
const MagicScrollbarDot = memo(function MagicScrollbarDot({
  entryId,
  label,
  top,
  isHovered,
  isActive,
  showPing,
  testID,
  onHoverChange,
  onJump,
}: MagicScrollbarDotProps) {
  const handlePointerEnter = useCallback(
    () => onHoverChange(entryId, true),
    [entryId, onHoverChange],
  );
  const handlePointerLeave = useCallback(
    () => onHoverChange(entryId, false),
    [entryId, onHoverChange],
  );
  const handlePress = useCallback(() => onJump(entryId), [entryId, onJump]);
  const hitStyle = useMemo(() => [styles.dotHit, inlineUnistylesStyle({ top })], [top]);
  const dotStyle = useMemo(() => {
    if (isHovered) {
      return [styles.dot, styles.dotHovered];
    }
    if (isActive) {
      return [styles.dot, styles.dotActive];
    }
    return styles.dot;
  }, [isActive, isHovered]);

  return (
    <View style={hitStyle} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={handlePress}
        style={styles.dotPressable}
        testID={testID}
      >
        {showPing ? <ActiveDotPing /> : null}
        <View style={dotStyle} />
      </Pressable>
    </View>
  );
});

/**
 * Magic scrollbar: a dot rail over the conversation with one dot per user
 * message. Hovering a dot previews the message (three lines max); clicking it
 * scrolls the stream to that message. The rail slides in from the right while
 * scrolling or while the pane is hovered, and slides back out after a short
 * idle delay — same behavior as HaikoMail's ThreadScrollbar.
 */
export function StreamMagicScrollbar({
  entries,
  visible,
  activeEntryId = null,
  onJumpToEntry,
}: StreamMagicScrollbarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [railHover, setRailHover] = useState(false);
  const [trackHeight, setTrackHeight] = useState(0);

  // Keep the rail open while the pointer interacts with it, even after the
  // parent's scroll-idle timer flips visible back to false.
  const show = visible || railHover || hoveredId !== null;

  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(show ? 1 : 0, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
    });
  }, [progress, show]);
  const slideStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * HIDE_TRANSLATE_X }],
  }));
  const containerStyle = useMemo(() => [positionStyles.container, slideStyle], [slideStyle]);

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackHeight(Math.round(event.nativeEvent.layout.height));
  }, []);
  const handleRailPointerEnter = useCallback(() => setRailHover(true), []);
  const handleRailPointerLeave = useCallback(() => setRailHover(false), []);
  const handleDotHoverChange = useCallback((entryId: string, hovered: boolean) => {
    setHoveredId((current) => {
      if (hovered) {
        return entryId;
      }
      return current === entryId ? null : current;
    });
  }, []);

  const innerHeight = Math.max(0, trackHeight - RAIL_INSET_VERTICAL * 2);

  // Downsample evenly (keeping first and last) when the track cannot fit one
  // dot per message without overlaps.
  const displayedEntries = useMemo(() => {
    const capacity = Math.max(2, Math.floor(innerHeight / MIN_DOT_SPACING_PX) + 1);
    if (entries.length <= capacity) {
      return entries;
    }
    const sampled: typeof entries = [];
    for (let slot = 0; slot < capacity; slot += 1) {
      const index = Math.round((slot * (entries.length - 1)) / (capacity - 1));
      const entry = entries[index];
      if (entry && sampled[sampled.length - 1] !== entry) {
        sampled.push(entry);
      }
    }
    return sampled;
  }, [entries, innerHeight]);

  // A dot can disappear under the pointer when entries change; drop the stale
  // hover instead of keeping the tooltip (and the rail) open forever.
  useEffect(() => {
    if (hoveredId && !displayedEntries.some((entry) => entry.id === hoveredId)) {
      setHoveredId(null);
    }
  }, [displayedEntries, hoveredId]);

  // When downsampling dropped the active message's dot, highlight the nearest
  // displayed dot instead so the rail always shows a reading position.
  const effectiveActiveId = useMemo(() => {
    if (!activeEntryId) {
      return null;
    }
    if (displayedEntries.some((entry) => entry.id === activeEntryId)) {
      return activeEntryId;
    }
    const indexById = new Map(entries.map((entry, index) => [entry.id, index] as const));
    const activeIndex = indexById.get(activeEntryId);
    if (activeIndex === undefined) {
      return null;
    }
    let nearestId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const entry of displayedEntries) {
      const index = indexById.get(entry.id);
      if (index === undefined) {
        continue;
      }
      const distance = Math.abs(index - activeIndex);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = entry.id;
      }
    }
    return nearestId;
  }, [activeEntryId, displayedEntries, entries]);

  const dotCenterForIndex = useCallback(
    (index: number) =>
      RAIL_INSET_VERTICAL +
      (displayedEntries.length <= 1
        ? innerHeight / 2
        : (index / (displayedEntries.length - 1)) * innerHeight),
    [displayedEntries.length, innerHeight],
  );

  const hoveredIndex = hoveredId
    ? displayedEntries.findIndex((entry) => entry.id === hoveredId)
    : -1;
  const hoveredEntry = hoveredIndex >= 0 ? displayedEntries[hoveredIndex] : null;

  // Anchor the tooltip's top edge near dots in the upper half and its bottom
  // edge near dots in the lower half, so it never clips out of the pane.
  const tooltipStyle = useMemo(() => {
    if (hoveredIndex < 0) {
      return null;
    }
    const dotCenter = dotCenterForIndex(hoveredIndex);
    const placement =
      dotCenter <= trackHeight / 2
        ? { top: Math.max(0, dotCenter - TOOLTIP_DOT_ALIGN_OFFSET_PX) }
        : { bottom: Math.max(0, trackHeight - dotCenter - TOOLTIP_DOT_ALIGN_OFFSET_PX) };
    return [styles.tooltip, inlineUnistylesStyle(placement)];
  }, [dotCenterForIndex, hoveredIndex, trackHeight]);

  return (
    <Animated.View
      style={containerStyle}
      pointerEvents={show ? "box-none" : "none"}
      testID="magic-scrollbar"
    >
      <View
        style={styles.track}
        onLayout={handleTrackLayout}
        onPointerEnter={handleRailPointerEnter}
        onPointerLeave={handleRailPointerLeave}
      >
        {trackHeight > 0
          ? displayedEntries.map((entry, index) => (
              <MagicScrollbarDot
                key={entry.id}
                entryId={entry.id}
                label={entry.text}
                top={dotCenterForIndex(index) - DOT_HIT_SIZE / 2}
                isHovered={hoveredId === entry.id}
                isActive={effectiveActiveId === entry.id}
                showPing={effectiveActiveId === entry.id && show}
                testID={`magic-scrollbar-dot-${index}`}
                onHoverChange={handleDotHoverChange}
                onJump={onJumpToEntry}
              />
            ))
          : null}
      </View>
      {hoveredEntry && tooltipStyle ? (
        <View pointerEvents="none" style={tooltipStyle}>
          <Text style={styles.tooltipText} numberOfLines={3}>
            {hoveredEntry.text}
          </Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    flex: 1,
    width: RAIL_WIDTH,
    borderRadius: RAIL_WIDTH / 2,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  dotHit: {
    position: "absolute",
    left: 0,
    right: 0,
    height: DOT_HIT_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  dotPressable: {
    width: DOT_HIT_SIZE,
    height: DOT_HIT_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.75,
  },
  dotHovered: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.accent,
    opacity: 1,
  },
  dotActive: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: theme.colors.accent,
    opacity: 1,
  },
  pingFill: {
    flex: 1,
    borderRadius: DOT_HIT_SIZE / 2,
    backgroundColor: theme.colors.accent,
  },
  tooltip: {
    position: "absolute",
    right: RAIL_WIDTH + 10,
    width: 280,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    ...theme.shadow.md,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
}));
