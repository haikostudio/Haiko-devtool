import { useEffect, useRef, useState } from "react";

/** How close (in px) the pointer must get to the left edge to reveal the sidebar. */
const REVEAL_ZONE_PX = 10;

/**
 * Reveals the collapsed sidebar as an overlay when the pointer approaches the
 * left edge of the window. Once revealed, it stays revealed while the pointer
 * is over the sidebar's width and hides again once the pointer moves past it.
 *
 * Only meaningful on web (mouse pointer). `enabled` should be false whenever the
 * sidebar is already open, on compact layouts, or when the chrome is unmounted.
 */
export function useLeftEdgePeek({
  enabled,
  sidebarWidth,
}: {
  enabled: boolean;
  sidebarWidth: number;
}): boolean {
  const [peeking, setPeeking] = useState(false);
  // Read the latest peeking state inside the pointermove handler without
  // re-subscribing the listener on every reveal/hide.
  const peekingRef = useRef(peeking);
  peekingRef.current = peeking;

  useEffect(() => {
    if (!enabled) {
      setPeeking(false);
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const x = event.clientX;
      if (x <= REVEAL_ZONE_PX) {
        if (!peekingRef.current) setPeeking(true);
      } else if (peekingRef.current && x > sidebarWidth) {
        setPeeking(false);
      }
    };
    // Hide when the pointer leaves the window entirely (e.g. exits via the top
    // while still within the reveal zone horizontally).
    const handlePointerLeave = () => setPeeking(false);

    window.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("blur", handlePointerLeave);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("blur", handlePointerLeave);
    };
  }, [enabled, sidebarWidth]);

  return enabled && peeking;
}
