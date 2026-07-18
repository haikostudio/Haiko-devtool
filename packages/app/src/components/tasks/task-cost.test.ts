import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  computeBillableCostChf,
  estimateTokenCostUsd,
  formatChf,
  formatUsd,
  resolveEffectiveExecution,
} from "./task-cost";

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude Code",
    models: [
      {
        provider: "claude",
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  },
];

describe("resolveEffectiveExecution", () => {
  it("resolves the provider default model and reasoning level when nothing is picked", () => {
    const effective = resolveEffectiveExecution({
      entries,
      selection: null,
      thinkingOptionId: null,
      mode: "direct",
    });
    expect(effective.modelId).toBe("claude-opus-4-8");
    expect(effective.modelLabel).toBe("Opus 4.8");
    expect(effective.modelIsDefault).toBe(true);
    expect(effective.thinkingId).toBe("high");
    expect(effective.thinkingLabel).toBe("High");
    expect(effective.thinkingIsDefault).toBe(true);
  });

  it("honours an explicit model + reasoning choice", () => {
    const effective = resolveEffectiveExecution({
      entries,
      selection: { provider: "claude", model: "claude-haiku-4-5" },
      thinkingOptionId: "low",
      mode: "plan",
    });
    expect(effective.modelId).toBe("claude-haiku-4-5");
    expect(effective.modelIsDefault).toBe(false);
    expect(effective.thinkingId).toBe("low");
    expect(effective.thinkingIsDefault).toBe(false);
    expect(effective.mode).toBe("plan");
  });

  it("falls back to the selection id while the snapshot is still loading", () => {
    const effective = resolveEffectiveExecution({
      entries: undefined,
      selection: { provider: "codex", model: "gpt-5.4" },
      thinkingOptionId: null,
      mode: "direct",
    });
    expect(effective.modelId).toBe("gpt-5.4");
    expect(effective.modelLabel).toBe("gpt-5.4");
  });
});

describe("cost helpers", () => {
  it("prices tokens per model family with a blended rate", () => {
    // 1M tokens on Opus at ~$10/Mtok blended.
    expect(estimateTokenCostUsd("claude-opus-4-8", 1_000_000)).toBeCloseTo(10);
    expect(estimateTokenCostUsd("claude-haiku-4-5", 1_000_000)).toBeCloseTo(2);
    expect(estimateTokenCostUsd("gpt-5.4", 1_000_000)).toBeCloseTo(5);
  });

  it("bills active minutes at 130 CHF/h", () => {
    expect(computeBillableCostChf(60)).toBeCloseTo(130);
    expect(computeBillableCostChf(30)).toBeCloseTo(65);
  });

  it("formats currency compactly", () => {
    expect(formatChf(21.6667)).toBe("22 CHF");
    expect(formatChf(4.2)).toBe("4.2 CHF");
    expect(formatUsd(1.8)).toBe("$1.80");
    expect(formatUsd(0.004)).toBe("< $0.01");
  });
});
