import { memo, useId, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import MaskedView from "@react-native-masked-view/masked-view";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

/**
 * Soft fade painted behind the floating synthesis banner (native). Without it,
 * the transcript butts against the banner with a hard edge — a scrolled line
 * pokes out right under the card and reads as a glitch. This scrim keeps the
 * panel background opaque behind the card, then fades to transparent just below
 * it, so content dissolves as it slides underneath instead of cutting abruptly.
 *
 * The panel color comes from a plain themed View (tracked by Unistyles); the
 * gradient is a fixed white→transparent alpha mask, so no theme value has to be
 * threaded through the SVG (wrapping an SVG <Stop> to theme it inserts a <div>
 * that breaks the gradient on web). Sits above the transcript, below the banner,
 * inert to touch. See the `.web.tsx` sibling for the CSS-gradient variant.
 */
const FADE_TAIL = 28;

export const AgentSynthesisScrim = memo(function AgentSynthesisScrim({
  extent,
}: {
  /** The banner's occupied vertical extent (its bottom edge from the panel top). */
  extent: number;
}) {
  const maskId = useId();
  const height = extent + FADE_TAIL;
  // Height is measured geometry: keep it off the Unistyles CSS registry.
  const hostStyle = useMemo(() => [styles.host, inlineUnistylesStyle({ height })], [height]);
  // Opaque down to the card's bottom edge, then fade over the tail.
  const solidOffset = extent / height;
  const maskElement = useMemo(
    () => (
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor="#fff" stopOpacity={1} />
            <Stop offset={solidOffset} stopColor="#fff" stopOpacity={1} />
            <Stop offset={1} stopColor="#fff" stopOpacity={0} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${maskId})`} />
      </Svg>
    ),
    [maskId, solidOffset],
  );
  if (extent <= 0) {
    return null;
  }
  return (
    <View style={hostStyle} pointerEvents="none">
      <MaskedView style={StyleSheet.absoluteFill} maskElement={maskElement}>
        <View style={styles.fill} />
      </MaskedView>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  fill: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
