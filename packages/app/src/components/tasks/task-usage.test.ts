import { describe, expect, it } from "vitest";

import { formatTokenCount, hasTaskUsage, totalTaskTokens } from "./task-usage";

function usage(overrides: Partial<Parameters<typeof totalTaskTokens>[0]> = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    turns: 0,
    updatedAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("totalTaskTokens", () => {
  it("adds input and output", () => {
    expect(totalTaskTokens(usage({ inputTokens: 1_000, outputTokens: 250 }))).toBe(1_250);
  });

  it("leaves cached input out of the total", () => {
    // Les fournisseurs comptent déjà le cache dans l'entrée : l'additionner
    // afficherait une explosion de consommation là où il y a une économie.
    const withCache = usage({ inputTokens: 1_000, outputTokens: 250, cachedInputTokens: 900 });
    expect(totalTaskTokens(withCache)).toBe(1_250);
  });
});

describe("formatTokenCount", () => {
  it("keeps small counts exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(940)).toBe("940");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("switches to thousands and millions", () => {
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(12_400)).toBe("12,4k");
    expect(formatTokenCount(128_000)).toBe("128k");
    expect(formatTokenCount(1_200_000)).toBe("1,2M");
  });

  it("never shows a negative or fractional count", () => {
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(12.7)).toBe("13");
  });
});

describe("hasTaskUsage", () => {
  it("is false for an absent or empty counter", () => {
    expect(hasTaskUsage(null)).toBe(false);
    expect(hasTaskUsage(undefined)).toBe(false);
    expect(hasTaskUsage(usage())).toBe(false);
  });

  it("is true as soon as something was spent", () => {
    expect(hasTaskUsage(usage({ outputTokens: 12 }))).toBe(true);
  });
});
