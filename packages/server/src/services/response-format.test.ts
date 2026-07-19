import { describe, expect, it } from "vitest";

import {
  hasResponseFormatDirective,
  injectResponseFormat,
  stripResponseFormat,
} from "./response-format.js";

describe("response-format directive", () => {
  it("prepends the directive envelope to a plain prompt", () => {
    const out = injectResponseFormat("fais le café");
    expect(out.startsWith("<paseo-format>\n")).toBe(true);
    expect(out.endsWith("\n\nfais le café")).toBe(true);
    expect(hasResponseFormatDirective(out)).toBe(true);
  });

  it("is idempotent — never double-wraps", () => {
    const once = injectResponseFormat("hello");
    expect(injectResponseFormat(once)).toBe(once);
  });

  it("round-trips: strip returns the original text", () => {
    const original = "corrige le bug de synthèse";
    expect(stripResponseFormat(injectResponseFormat(original))).toBe(original);
  });

  it("strips only the leading envelope, leaving a following brain block intact", () => {
    const inner = '<contexte_memoire source="cerveau" portee="projet">\nx\n</contexte_memoire>';
    const wrapped = injectResponseFormat(inner);
    expect(stripResponseFormat(wrapped)).toBe(inner);
  });

  it("strip is a no-op when the directive is absent", () => {
    expect(stripResponseFormat("no envelope here")).toBe("no envelope here");
    expect(hasResponseFormatDirective("no envelope here")).toBe(false);
  });
});
