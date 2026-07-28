import { describe, expect, it } from "vitest";
import { createPressSlopTracker, PRESS_SLOP_PX } from "./card-press-slop";

describe("createPressSlopTracker", () => {
  it("lets a plain tap through", () => {
    const slop = createPressSlopTracker();
    slop.down(120, 200);
    slop.up(121, 201);
    expect(slop.shouldSuppressPress()).toBe(false);
  });

  it("swallows the press that ends a pointer travel past the slop", () => {
    const slop = createPressSlopTracker();
    slop.down(120, 200);
    slop.up(120 + PRESS_SLOP_PX + 4, 200);
    expect(slop.shouldSuppressPress()).toBe(true);
  });

  it("swallows the press after a real drag even when the pointer lands back home", () => {
    const slop = createPressSlopTracker();
    slop.down(120, 200);
    slop.markDragging();
    slop.up(120, 200);
    expect(slop.shouldSuppressPress()).toBe(true);
  });

  it("forgets the verdict once used, so the next tap still works", () => {
    const slop = createPressSlopTracker();
    slop.down(120, 200);
    slop.up(400, 400);
    expect(slop.shouldSuppressPress()).toBe(true);
    slop.down(120, 200);
    slop.up(120, 200);
    expect(slop.shouldSuppressPress()).toBe(false);
  });

  it("does not leak a drag verdict into a gesture that never came up", () => {
    const slop = createPressSlopTracker();
    slop.down(120, 200);
    slop.markDragging();
    expect(slop.shouldSuppressPress()).toBe(true);
    // Pointerup never reached the card (drop landed elsewhere): the next real
    // tap must not inherit the drag.
    slop.down(120, 200);
    slop.up(120, 200);
    expect(slop.shouldSuppressPress()).toBe(false);
  });
});
