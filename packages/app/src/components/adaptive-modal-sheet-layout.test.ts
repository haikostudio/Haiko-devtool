import { describe, expect, it } from "vitest";
import { getCompactSheetSafeAreaPadding } from "@/components/adaptive-modal-sheet-layout";

describe("getCompactSheetSafeAreaPadding", () => {
  it("adds the bottom inset to compact sheet footers", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        hasFooter: true,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({ footerPaddingBottom: 46 });
  });

  it("keeps a minimum gap under compact footers when no inset is reported", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        hasFooter: true,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 0,
      }),
    ).toEqual({ footerPaddingBottom: 28 });
  });

  it("adds the bottom inset to compact sheet content when there is no footer", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        hasFooter: false,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({ contentPaddingBottom: 58 });
  });

  // The task dock passes contentVerticalPaddingScale={0}: its composer sits at
  // the bottom of a full-height pane, so the only gap under it is the phone's
  // own safe area — no sheet indent stacked on top of it.
  it("leaves only the safe area under a body that opted out of vertical padding", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        hasFooter: false,
        baseContentPadding: 0,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({ contentPaddingBottom: 34 });
  });

  it("does not inset desktop sheets", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: false,
        hasFooter: false,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({});
  });
});
