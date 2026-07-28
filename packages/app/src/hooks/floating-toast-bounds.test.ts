import { describe, expect, it } from "vitest";
import { clampFloatingToastX, resolveFloatingToastSnapX } from "@/hooks/floating-toast-bounds";

// The floating pile rests at `right: rightOffset` and is drawn shifted left by
// the reserved inset. `minX` is how far left it may travel on a bare window,
// `maxX` how far right (back to the resting edge).
const BARE = { minX: -800, maxX: 44 };

describe("clampFloatingToastX", () => {
  it("keeps the window bounds when nothing is reserved", () => {
    expect(clampFloatingToastX({ x: -900, ...BARE, rightInset: 0 })).toBe(-800);
    expect(clampFloatingToastX({ x: 200, ...BARE, rightInset: 0 })).toBe(44);
    expect(clampFloatingToastX({ x: -120, ...BARE, rightInset: 0 })).toBe(-120);
  });

  it("gives back the left travel taken by an open side panel", () => {
    // The element is already drawn 360px left; without this the left half of the
    // pile would hang off the window edge.
    expect(clampFloatingToastX({ x: -800, ...BARE, rightInset: 360 })).toBe(-440);
  });

  it("frees the travel again when the panel closes", () => {
    expect(clampFloatingToastX({ x: -800, ...BARE, rightInset: 0 })).toBe(-800);
  });

  it("never lets the left bound cross the right bound on a very wide panel", () => {
    expect(clampFloatingToastX({ x: 0, ...BARE, rightInset: 5000 })).toBe(44);
  });
});

describe("resolveFloatingToastSnapX", () => {
  const MAGNET = { threshold: 72, margin: 12 };

  it("snaps to the panel's border, not the window's, on the right", () => {
    expect(resolveFloatingToastSnapX({ x: 20, ...BARE, rightInset: 360, ...MAGNET })).toBe(32);
  });

  it("snaps to the visible left edge once a panel is open", () => {
    expect(resolveFloatingToastSnapX({ x: -420, ...BARE, rightInset: 360, ...MAGNET })).toBe(-428);
  });

  it("leaves a drop far from both edges exactly where it landed", () => {
    expect(resolveFloatingToastSnapX({ x: -200, ...BARE, rightInset: 0, ...MAGNET })).toBe(-200);
  });
});
