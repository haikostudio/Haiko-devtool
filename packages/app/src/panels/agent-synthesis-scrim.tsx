import { memo, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

/**
 * Soft fade painted behind the floating synthesis banner. Without it, the
 * transcript scrolls up and butts against the banner with a hard edge — a
 * scrolled line pokes out right under the card and reads as a glitch. This scrim
 * keeps the panel background opaque behind the card, then fades to transparent
 * just below it, so content dissolves as it slides underneath instead of
 * cutting off abruptly.
 *
 * Sits above the transcript but below the banner (zIndex between the two) and is
 * inert to touch. Renders nothing until the banner reports its extent.
 */
const FADE_TAIL = 28;

const surface0StopMapping = (theme: Theme) => ({
  stopColor: theme.colors.surface0,
});

const ThemedStop = withUnistyles(Stop);

export const AgentSynthesisScrim = memo(function AgentSynthesisScrim({
  extent,
}: {
  /** The banner's occupied vertical extent (its bottom edge from the panel top). */
  extent: number;
}) {
  const height = extent + FADE_TAIL;
  // Height is measured geometry: keep it off the Unistyles CSS registry.
  const hostStyle = useMemo(() => [styles.host, inlineUnistylesStyle({ height })], [height]);
  if (extent <= 0) {
    return null;
  }
  // Opaque down to the card's bottom edge, then fade over the tail.
  const solidOffset = extent / height;
  return (
    <View style={hostStyle} pointerEvents="none">
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id="synthesisScrim" x1="0" y1="0" x2="0" y2="1">
            <ThemedStop offset={0} stopOpacity={1} uniProps={surface0StopMapping} />
            <ThemedStop offset={solidOffset} stopOpacity={1} uniProps={surface0StopMapping} />
            <ThemedStop offset={1} stopOpacity={0} uniProps={surface0StopMapping} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#synthesisScrim)" />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
});
