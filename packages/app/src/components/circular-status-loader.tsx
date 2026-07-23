import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  createAnimatedComponent,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useRetainedPanelActive } from "@/components/retained-panel";

const AnimatedCircle = createAnimatedComponent(Circle);

// One half of the fill/empty cycle: the ring winds up over this duration, then
// unwinds over the same span (withRepeat reverse), so a full loop is ~2x this.
const FILL_DURATION_MS = 820;
// A slow continuous spin so the winding point travels around the ring instead of
// pulsing from a fixed spot — reads as an active loader rather than a heartbeat.
const ROTATION_DURATION_MS = 1600;
const STROKE_RATIO = 0.2;
const MIN_STROKE_WIDTH = 1.25;
// Faint backdrop ring so the circle shape stays legible while the fill unwinds.
const TRACK_OPACITY = 0.22;
// When motion is reduced, freeze at a partly-filled ring so the status still reads
// as "in progress" without any looping animation.
const REDUCED_MOTION_PROGRESS = 0.7;

/**
 * A small circular loader whose stroke winds up to a full ring and unwinds back to
 * empty in a loop, used for the "running" status dot in the sidebar. Pauses when its
 * panel is inactive and falls back to a static partial ring when motion is reduced.
 */
export function CircularStatusLoader({ size = 11, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? REDUCED_MOTION_PROGRESS : 0);
  const rotation = useSharedValue(0);

  const geometry = useMemo(() => {
    const strokeWidth = Math.max(MIN_STROKE_WIDTH, size * STROKE_RATIO);
    const radius = (size - strokeWidth) / 2;
    return {
      strokeWidth,
      radius,
      center: size / 2,
      circumference: 2 * Math.PI * radius,
    };
  }, [size]);
  const { strokeWidth, radius, center, circumference } = geometry;

  useEffect(() => {
    if (reduceMotion || !active) {
      cancelAnimation(progress);
      cancelAnimation(rotation);
      if (reduceMotion) {
        progress.value = REDUCED_MOTION_PROGRESS;
        rotation.value = 0;
      }
      return;
    }

    progress.value = withRepeat(
      withTiming(1, { duration: FILL_DURATION_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    rotation.value = withRepeat(
      withTiming(360, { duration: ROTATION_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(progress);
      cancelAnimation(rotation);
    };
  }, [active, reduceMotion, progress, rotation]);

  const animatedCircleProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  const animatedRotationStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const containerStyle = useMemo(
    () => ({ width: size, height: size, alignItems: "center", justifyContent: "center" }) as const,
    [size],
  );
  // Start the winding point at the top of the ring (SVG 0deg is at 3 o'clock).
  const svgStyle = useMemo(() => ({ transform: [{ rotate: "-90deg" }] }) as const, []);

  return (
    <View style={containerStyle}>
      <Animated.View style={animatedRotationStyle}>
        <Svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={svgStyle}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            opacity={TRACK_OPACITY}
          />
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            animatedProps={animatedCircleProps}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}
