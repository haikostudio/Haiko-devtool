import { memo, useMemo } from "react";

/**
 * Soft fade painted behind the floating synthesis banner (web + Electron).
 * Without it, the transcript butts against the banner with a hard edge — a
 * scrolled line pokes out right under the card and reads as a glitch. This scrim
 * keeps the panel background opaque behind the card, then fades to transparent
 * just below it, so content dissolves as it slides underneath.
 *
 * A plain <div> with a CSS gradient is the robust web path: the panel color is
 * read straight from the Unistyles runtime CSS variable (theme-reactive for
 * free), and CSS handles the fade. The native sibling (`.tsx`) uses a MaskedView
 * instead. Inert to touch, sits above the transcript and below the banner.
 */
const FADE_TAIL = 28;

export const AgentSynthesisScrim = memo(function AgentSynthesisScrim({
  extent,
}: {
  /** The banner's occupied vertical extent (its bottom edge from the panel top). */
  extent: number;
}) {
  const height = extent + FADE_TAIL;
  // Opaque down to the card's bottom edge, then fade over the tail.
  const solidPct = Math.round((extent / height) * 100);
  const style = useMemo<React.CSSProperties>(
    () => ({
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height,
      zIndex: 20,
      pointerEvents: "none",
      background: `linear-gradient(to bottom, var(--colors-surface0) 0%, var(--colors-surface0) ${solidPct}%, transparent 100%)`,
    }),
    [height, solidPct],
  );
  if (extent <= 0) {
    return null;
  }
  return <div aria-hidden style={style} />;
});
