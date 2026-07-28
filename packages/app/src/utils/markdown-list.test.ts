import { describe, expect, it } from "vitest";
import {
  getMarkdownForcedOrderedMarker,
  getMarkdownListMarker,
  getMarkdownListSpacing,
} from "./markdown-list";

describe("getMarkdownListMarker", () => {
  it("returns a bullet marker for unordered list items", () => {
    expect(getMarkdownListMarker({ index: 0 }, [{ type: "bullet_list" }])).toEqual({
      isOrdered: false,
      marker: "•",
    });
  });

  it("returns numbered markers for ordered list items", () => {
    expect(getMarkdownListMarker({ index: 1, markup: "." }, [{ type: "ordered_list" }])).toEqual({
      isOrdered: true,
      marker: "2.",
    });
  });

  it("respects ordered list start attribute", () => {
    expect(
      getMarkdownListMarker({ index: 2, markup: ")" }, [
        { type: "ordered_list", attributes: { start: "5" } },
      ]),
    ).toEqual({
      isOrdered: true,
      marker: "7)",
    });
  });

  it("prefers the nearest list ancestor in nested lists", () => {
    expect(
      getMarkdownListMarker({ index: 0, markup: "." }, [
        { type: "ordered_list" },
        { type: "bullet_list" },
      ]),
    ).toEqual({
      isOrdered: true,
      marker: "1.",
    });
  });
});

describe("getMarkdownForcedOrderedMarker", () => {
  it("numbers top-level bullets", () => {
    const list = { type: "bullet_list" };
    const markers = [0, 1, 2].map(
      (index) => getMarkdownForcedOrderedMarker({ index }, [list]).marker,
    );
    expect(markers).toEqual(["1.", "2.", "3."]);
  });

  it("reports forced markers as ordered so ordered styles apply", () => {
    expect(getMarkdownForcedOrderedMarker({ index: 0 }, [{ type: "bullet_list" }]).isOrdered).toBe(
      true,
    );
  });

  it("keeps plain bullets for nested lists", () => {
    expect(
      getMarkdownForcedOrderedMarker({ index: 1 }, [
        { type: "list_item" },
        { type: "bullet_list" },
      ]),
    ).toEqual({
      isOrdered: false,
      marker: "•",
    });
  });

  it("leaves genuine ordered lists to the normal numbering", () => {
    expect(
      getMarkdownForcedOrderedMarker({ index: 0, markup: "." }, [
        { type: "ordered_list", attributes: { start: 4 } },
      ]),
    ).toEqual({
      isOrdered: true,
      marker: "4.",
    });
  });

  it("falls back to a bullet outside any list", () => {
    expect(getMarkdownForcedOrderedMarker({ index: 0 }, [])).toEqual({
      isOrdered: false,
      marker: "•",
    });
  });
});

describe("getMarkdownListSpacing", () => {
  it("keeps top-level list spacing as a section boundary", () => {
    const paragraph = { type: "paragraph" };
    const list = { type: "bullet_list" };
    const body = { type: "body", children: [list, paragraph] };

    expect(getMarkdownListSpacing(list, [body])).toEqual({
      marginTop: 4,
      marginBottom: 16,
    });
  });

  it("does not add bottom spacing after a list at the end of a markdown block", () => {
    const list = { type: "bullet_list" };
    const body = { type: "body", children: [list] };

    expect(getMarkdownListSpacing(list, [body])).toEqual({
      marginTop: 4,
      marginBottom: 0,
    });
  });

  it("uses a smaller gap between adjacent top-level lists", () => {
    const list = { type: "bullet_list" };
    const body = { type: "body", children: [list, { type: "ordered_list" }] };

    expect(getMarkdownListSpacing(list, [body])).toEqual({
      marginTop: 4,
      marginBottom: 8,
    });
  });

  it("does not add section spacing after a nested list", () => {
    expect(
      getMarkdownListSpacing({ type: "bullet_list" }, [
        { type: "list_item" },
        { type: "bullet_list" },
        { type: "body" },
      ]),
    ).toEqual({
      marginTop: 4,
      marginBottom: 0,
    });
  });
});
