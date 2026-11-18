export interface UsageSettings {
  creditValueUsd: number;
  stufloMonthlyCredits: number;
  stuproMonthlyCredits: number;
  warningThresholds: [number, number, number];
  dailyAiBudgetUsd: number;
  monthlyAiBudgetUsd: number;
  budgetWarningThresholds: [number, number, number];
}

export interface ModelUsage {
  provider?: string | null;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
}

export interface UsageCharge {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  estimatedProviderCostUsd: number;
  creditValueUsd: number;
  creditsCharged: number;
  usageQuality: 'detailed' | 'missing';
}

export class UsageCreditsExhaustedError extends Error {
  readonly code = 'credits_exhausted';

  constructor() {
    super('No usage credits remain for this billing period.');
    this.name = 'UsageCreditsExhaustedError';
  }
}

export class GlobalUsageBudgetExceededError extends Error {
  readonly code = 'global_ai_budget_exceeded';

  constructor(public readonly period: 'daily' | 'monthly') {
    super(`The ${period} AI cost budget has been reached.`);
    this.name = 'GlobalUsageBudgetExceededError';
  }
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  creditValueUsd: 0.02,
  stufloMonthlyCredits: 25,
  stuproMonthlyCredits: 250,
  warningThresholds: [0.5, 0.8, 0.95],
  dailyAiBudgetUsd: 25,
  monthlyAiBudgetUsd: 500,
  budgetWarningThresholds: [0.5, 0.8, 1],
};

const MODEL_PRICING = [
  // Standard processing, verified against the official model pages 2026-10-02.
  {
    match: /^(?:openai\/)?gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/i,
    provider: 'openai',
    model: 'gpt-6-luna',
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.01,
    cacheWriteInputPerMillion: 0.125,
    outputPerMillion: 0.5,
  },
  {
    match: /^(?:openai\/)?gpt-6-sol(?:-\d{4}-\d{2}-\d{2})?$/i,
    provider: 'openai',
    model: 'gpt-6-sol',
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    cacheWriteInputPerMillion: 2.5,
    outputPerMillion: 10,
  },
  {
    match: /^(?:openai\/)?gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/i,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    cacheWriteInputPerMillion: 0.25,
    outputPerMillion: 1.2,
  },
  {
    match: /^(?:openai\/)?gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/i,
    provider: 'openai',
    model: 'gpt-5.6-terra',
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    cacheWriteInputPerMillion: 2.5,
    outputPerMillion: 12,
  },
  {
    match: /^(?:openai\/)?gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/i,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    inputPerMillion: 4,
    cachedInputPerMillion: 0.4,
    cacheWriteInputPerMillion: 5,
    outputPerMillion: 20,
  },
  {
    match: /(?:@cf\/moonshotai\/)?kimi-k2\.6/i,
    provider: 'workers-ai',
    model: '@cf/moonshotai/kimi-k2.6',
    inputPerMillion: 0.95,
    cachedInputPerMillion: 0.16,
    cacheWriteInputPerMillion: 0.95,
    outputPerMillion: 4,
  },
  {
    match: /(?:@cf\/moonshotai\/)?kimi-k2\.5/i,
    provider: 'workers-ai',
    model: '@cf/moonshotai/kimi-k2.5',
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.1,
    cacheWriteInputPerMillion: 0.6,
    outputPerMillion: 3,
  },
] as const;

const FALLBACK_PRICING = {
  provider: 'unknown',
  inputPerMillion: 3,
  cachedInputPerMillion: 1,
  cacheWriteInputPerMillion: 3,
  outputPerMillion: 15,
};

function finiteNonnegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function roundCredits(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function planMonthlyCredits(plan: string, settings = DEFAULT_USAGE_SETTINGS): number {
  if (plan === 'stupro') return finiteNonnegative(settings.stuproMonthlyCredits);
  if (plan === 'stuflo' || plan === 'free') {
    return finiteNonnegative(settings.stufloMonthlyCredits);
  }
  return 0;
}

export function normalizeUsageSettings(value: unknown): UsageSettings {
  const source = value && typeof value === 'object' ? (value as Partial<UsageSettings>) : {};
  const numberOr = (candidate: unknown, fallback: number) => {
    const number = Number(candidate);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const candidateThresholds = Array.isArray(source.warningThresholds)
    ? source.warningThresholds.map(Number)
    : [];
  const warningThresholds: [number, number, number] =
    candidateThresholds.length === 3 &&
    candidateThresholds.every((threshold) => threshold > 0 && threshold <= 1) &&
    candidateThresholds[0] < candidateThresholds[1] &&
    candidateThresholds[1] < candidateThresholds[2]
      ? [candidateThresholds[0], candidateThresholds[1], candidateThresholds[2]]
      : [...DEFAULT_USAGE_SETTINGS.warningThresholds];
  const candidateBudgetThresholds = Array.isArray(source.budgetWarningThresholds)
    ? source.budgetWarningThresholds.map(Number)
    : [];
  const budgetWarningThresholds: [number, number, number] =
    candidateBudgetThresholds.length === 3 &&
    candidateBudgetThresholds.every((threshold) => threshold > 0 && threshold <= 1) &&
    candidateBudgetThresholds[0] < candidateBudgetThresholds[1] &&
    candidateBudgetThresholds[1] < candidateBudgetThresholds[2]
      ? [candidateBudgetThresholds[0], candidateBudgetThresholds[1], candidateBudgetThresholds[2]]
      : [...DEFAULT_USAGE_SETTINGS.budgetWarningThresholds];
  return {
    creditValueUsd: numberOr(source.creditValueUsd, DEFAULT_USAGE_SETTINGS.creditValueUsd),
    stufloMonthlyCredits: numberOr(
      source.stufloMonthlyCredits,
      DEFAULT_USAGE_SETTINGS.stufloMonthlyCredits,
    ),
    stuproMonthlyCredits: numberOr(
      source.stuproMonthlyCredits,
      DEFAULT_USAGE_SETTINGS.stuproMonthlyCredits,
    ),
    warningThresholds,
    dailyAiBudgetUsd: numberOr(
      source.dailyAiBudgetUsd,
      DEFAULT_USAGE_SETTINGS.dailyAiBudgetUsd,
    ),
    monthlyAiBudgetUsd: numberOr(
      source.monthlyAiBudgetUsd,
      DEFAULT_USAGE_SETTINGS.monthlyAiBudgetUsd,
    ),
    budgetWarningThresholds,
  };
}

export function estimateUsageCharge(
  usage: ModelUsage,
  creditValueUsd = DEFAULT_USAGE_SETTINGS.creditValueUsd,
): UsageCharge {
  const pricing = MODEL_PRICING.find((entry) => entry.match.test(usage.model)) || {
    ...FALLBACK_PRICING,
    model: usage.model || 'unknown',
  };
  const hasDetailedUsage =
    usage.inputTokens != null ||
    usage.outputTokens != null ||
    usage.cachedInputTokens != null ||
    usage.cacheWriteInputTokens != null;
  const inputTokens = finiteNonnegative(usage.inputTokens);
  const outputTokens = finiteNonnegative(usage.outputTokens);
  // Cached reads/writes are subsets of input_tokens, never additional tokens.
  // Clamp malformed provider metadata so it cannot double-charge a student.
  const cachedInputTokens = Math.min(inputTokens, finiteNonnegative(usage.cachedInputTokens));
  const cacheWriteInputTokens = Math.min(
    inputTokens - cachedInputTokens,
    finiteNonnegative(usage.cacheWriteInputTokens),
  );
  const uncachedInputTokens = Math.max(
    0,
    inputTokens - cachedInputTokens - cacheWriteInputTokens,
  );
  const estimatedProviderCostUsd = hasDetailedUsage
    ? roundUsd(
        ((uncachedInputTokens * pricing.inputPerMillion +
          cachedInputTokens * pricing.cachedInputPerMillion +
          cacheWriteInputTokens * pricing.cacheWriteInputPerMillion) *
          (pricing.provider === 'openai' && inputTokens > 272_000 ? 2 : 1) +
          outputTokens * pricing.outputPerMillion *
          (pricing.provider === 'openai' && inputTokens > 272_000 ? 1.5 : 1)) /
          1_000_000,
      )
    : 0.002;
  const safeCreditValue = Math.max(0.0001, finiteNonnegative(creditValueUsd) || 0.02);
  return {
    provider: usage.provider || pricing.provider,
    model: pricing.model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    estimatedProviderCostUsd,
    creditValueUsd: safeCreditValue,
    creditsCharged: roundCredits(estimatedProviderCostUsd / safeCreditValue),
    usageQuality: hasDetailedUsage ? 'detailed' : 'missing',
  };
}

export function combineUsageCharges(charges: UsageCharge[]): UsageCharge {
  if (charges.length === 0) {
    return estimateUsageCharge({ model: 'unknown', inputTokens: 0, outputTokens: 0 });
  }
  const models = [...new Set(charges.map((charge) => charge.model))];
  const providers = [...new Set(charges.map((charge) => charge.provider))];
  return {
    provider: providers.length === 1 ? providers[0] : 'mixed',
    model: models.length === 1 ? models[0] : 'mixed',
    inputTokens: charges.reduce((sum, charge) => sum + charge.inputTokens, 0),
    outputTokens: charges.reduce((sum, charge) => sum + charge.outputTokens, 0),
    cachedInputTokens: charges.reduce((sum, charge) => sum + charge.cachedInputTokens, 0),
    cacheWriteInputTokens: charges.reduce(
      (sum, charge) => sum + charge.cacheWriteInputTokens,
      0,
    ),
    estimatedProviderCostUsd: roundUsd(
      charges.reduce((sum, charge) => sum + charge.estimatedProviderCostUsd, 0),
    ),
    creditValueUsd: charges[0].creditValueUsd,
    creditsCharged: roundCredits(charges.reduce((sum, charge) => sum + charge.creditsCharged, 0)),
    usageQuality: charges.every((charge) => charge.usageQuality === 'detailed')
      ? 'detailed'
      : 'missing',
  };
}

export function usageWarningLevel(
  creditsGranted: number,
  creditsRemaining: number,
  thresholds = DEFAULT_USAGE_SETTINGS.warningThresholds,
): 'ok' | 'notice' | 'warning' | 'critical' | 'exhausted' {
  if (creditsRemaining <= 0) return 'exhausted';
  const usedRatio = creditsGranted > 0 ? (creditsGranted - creditsRemaining) / creditsGranted : 1;
  if (usedRatio >= thresholds[2]) return 'critical';
  if (usedRatio >= thresholds[1]) return 'warning';
  if (usedRatio >= thresholds[0]) return 'notice';
  return 'ok';
}
