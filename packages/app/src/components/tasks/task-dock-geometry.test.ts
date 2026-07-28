import { describe, expect, it } from "vitest";
import {
  MOBILE_DOCK_SNAP_POINTS,
  MOBILE_DOCK_TOP_GAP,
  mobileDockVisibleHeight,
} from "./task-dock-geometry";

describe("mobile task dock geometry", () => {
  it("snaps to the full container so the drawer never stops mid-screen", () => {
    expect(MOBILE_DOCK_SNAP_POINTS).toEqual(["100%"]);
  });

  it("reserves only the app header above the drawer", () => {
    // Status bar is handled by the safe-area inset; the gap is the header row.
    expect(MOBILE_DOCK_TOP_GAP).toBeLessThanOrEqual(72);
  });

  it("fills nearly the whole screen on a phone", () => {
    // iPhone 14-class viewport: 844pt tall, 47pt notch inset.
    const height = mobileDockVisibleHeight({ screenHeight: 844, safeAreaTop: 47 });
    expect(height / 844).toBeGreaterThan(0.85);
  });

  it("clamps to zero on a degenerate viewport instead of going negative", () => {
    expect(mobileDockVisibleHeight({ screenHeight: 40, safeAreaTop: 0 })).toBe(0);
  });
});
