import { describe, expect, it } from "vitest";
import { parseCalloutBlock } from "../markdown-callout";

describe("parseCalloutBlock", () => {
  it("returns null for non-blockquote blocks", () => {
    expect(parseCalloutBlock("Just a paragraph")).toBeNull();
    expect(parseCalloutBlock("- a list item")).toBeNull();
    expect(parseCalloutBlock("# Heading")).toBeNull();
  });

  it("treats a plain blockquote as an untitled tip callout", () => {
    const result = parseCalloutBlock("> some advice\n> spanning two lines");
    expect(result).toEqual({
      type: "tip",
      heading: null,
      body: "some advice\nspanning two lines",
    });
  });

  it("detects GitHub alert markers and strips the marker line", () => {
    expect(parseCalloutBlock("> [!WARNING]\n> be careful here")).toEqual({
      type: "warning",
      heading: "Attention",
      body: "be careful here",
    });
    expect(parseCalloutBlock("> [!NOTE]\n> just so you know")).toMatchObject({
      type: "note",
      heading: "Note",
    });
  });

  it("is case-insensitive and accepts French aliases", () => {
    expect(parseCalloutBlock("> [!tip]\n> astuce")).toMatchObject({ type: "tip" });
    expect(parseCalloutBlock("> [!Conseil]\n> essaie ceci")).toMatchObject({
      type: "tip",
      heading: "Conseil",
    });
    expect(parseCalloutBlock("> [!DANGER]\n> attention")).toMatchObject({ type: "caution" });
  });

  it("keeps an inline title after the marker as the heading", () => {
    expect(parseCalloutBlock("> [!IMPORTANT] Lis ceci d'abord\n> le corps")).toEqual({
      type: "important",
      heading: "Lis ceci d'abord",
      body: "le corps",
    });
  });

  it("ignores unknown markers and keeps them in the body as a plain tip", () => {
    expect(parseCalloutBlock("> [!BOGUS]\n> body")).toEqual({
      type: "tip",
      heading: null,
      body: "[!BOGUS]\nbody",
    });
  });

  it("tolerates lazy continuation lines and leading indentation", () => {
    expect(parseCalloutBlock("> [!TIP]\ncontinued line")).toEqual({
      type: "tip",
      heading: "Conseil",
      body: "continued line",
    });
  });
});
