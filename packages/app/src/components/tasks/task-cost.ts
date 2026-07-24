import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

// Cost + execution resolution for the task detail form. Everything here is
// display-only: the scheduler resolves the provider default itself at launch,
// but the form must show the *concrete* model and reasoning level the user is
// committing to — never a bare "Default" — plus the two cost lenses the user
// arbitrates on: billable time and estimated token spend.

// The scheduler falls back to this provider when a task carries no runConfig.
const DEFAULT_PROVIDER = "claude";

/** User's billable rate. A short task at 130 CHF/h is the reference cost. */
export const BILLABLE_HOURLY_RATE_CHF = 130;

export interface TaskModelSelection {
  provider: string;
  model?: string;
}

export interface EffectiveExecution {
  provider: string;
  providerLabel: string;
  // Resolved concrete model id (used for token pricing). Null while the
  // provider snapshot is still loading and no explicit model was picked.
  modelId: string | null;
  modelLabel: string;
  // True when the model was resolved from the provider default (user left it
  // on "Default") rather than explicitly chosen.
  modelIsDefault: boolean;
  thinkingId: string | null;
  thinkingLabel: string | null;
  thinkingIsDefault: boolean;
  mode: "direct" | "plan";
}

function pickModelDefinition(
  models: AgentModelDefinition[],
  pickedModelId: string | undefined,
): AgentModelDefinition | undefined {
  if (pickedModelId) {
    return models.find((model) => model.id === pickedModelId);
  }
  return models.find((model) => model.isDefault) ?? models[0];
}

function pickThinkingId(
  model: AgentModelDefinition | undefined,
  pickedThinkingId: string | null,
): string | null {
  if (pickedThinkingId) {
    return pickedThinkingId;
  }
  const fallback =
    model?.defaultThinkingOptionId ??
    model?.thinkingOptions?.find((option) => option.isDefault)?.id;
  return fallback ?? null;
}

/**
 * Resolves what will actually run from the user's (possibly-default) selection
 * against the live provider snapshot. When the user leaves model or reasoning
 * on "Default", this surfaces the concrete model id / thinking option the
 * provider would pick, so the form can display it explicitly.
 */
export function resolveEffectiveExecution(input: {
  entries: ProviderSnapshotEntry[] | undefined;
  selection: TaskModelSelection | null;
  thinkingOptionId: string | null;
  mode: "direct" | "plan";
}): EffectiveExecution {
  const provider = input.selection?.provider ?? DEFAULT_PROVIDER;
  const entry = input.entries?.find((item) => item.provider === provider);
  const providerLabel = entry?.label ?? provider;

  const pickedModelId = input.selection?.model;
  const resolvedModel = pickModelDefinition(entry?.models ?? [], pickedModelId);

  const resolvedThinkingId = pickThinkingId(resolvedModel, input.thinkingOptionId);
  const thinkingLabel =
    resolvedModel?.thinkingOptions?.find((option) => option.id === resolvedThinkingId)?.label ??
    resolvedThinkingId;

  return {
    provider,
    providerLabel,
    modelId: resolvedModel?.id ?? pickedModelId ?? null,
    modelLabel: resolvedModel?.label ?? pickedModelId ?? providerLabel,
    modelIsDefault: !pickedModelId,
    thinkingId: resolvedThinkingId,
    thinkingLabel,
    thinkingIsDefault: !input.thinkingOptionId,
    mode: input.mode,
  };
}

// Blended USD per million tokens (input+output combined), since the estimator
// reports a single total-token figure. Values approximate a coding-agent mix
// (context-heavy reads, lighter writes) from published per-model pricing; see
// server/stats/claude-transcript-backfill.ts for the underlying rates.
function blendedUsdPerMTok(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes("opus")) return 10; // ~$5 in / $25 out
  if (id.includes("sonnet")) return 6; // ~$3 in / $15 out
  if (id.includes("haiku")) return 2; // ~$1 in / $5 out
  if (id.includes("gpt") || id.includes("codex") || id.includes("o1") || id.includes("o3")) {
    return 5;
  }
  return 6; // sensible default for unknown models
}

/** Estimated monetary token cost for `tokens` run on `modelId`, in USD. */
export function estimateTokenCostUsd(modelId: string, tokens: number): number {
  return (tokens / 1_000_000) * blendedUsdPerMTok(modelId);
}

/** Billable cost of `minutes` of active agent runtime at the reference rate. */
export function computeBillableCostChf(minutes: number): number {
  return (minutes / 60) * BILLABLE_HOURLY_RATE_CHF;
}

/**
 * Real (manual) billing amount for a task line: the senior-developer hours the
 * analysis agent estimated, times the project's configured rate. This is the
 * "prix réel" lens — distinct from the agent-runtime cost above.
 */
export function computeManualBillingChf(
  hours: number,
  rateChf: number = BILLABLE_HOURLY_RATE_CHF,
): number {
  return hours * rateChf;
}

export function formatChf(amount: number): string {
  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} CHF`;
}

export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) {
    return "< $0.01";
  }
  return `$${amount.toFixed(2)}`;
}
