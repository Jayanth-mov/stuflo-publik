import { describe, expect, it } from 'vitest';
import {
  combineUsageCharges,
  estimateUsageCharge,
  normalizeUsageSettings,
  planMonthlyCredits,
  usageWarningLevel,
} from '../src';

describe('usage credits', () => {
  it.each([
    ['gpt-6-luna', 0.5, 0.01, 0.125],
    ['gpt-6-sol', 10, 0.2, 2.5],
    ['gpt-5.6-sol', 20, 0.4, 5],
  ])('uses documented standard prices for %s', (model, outputPrice, cachedPrice, writePrice) => {
    const cached = estimateUsageCharge({ model, inputTokens: 1_000, cachedInputTokens: 1_000, outputTokens: 1_000 });
    expect(cached.estimatedProviderCostUsd).toBeCloseTo((outputPrice + cachedPrice) / 1_000, 8);
    const write = estimateUsageCharge({ model, inputTokens: 1_000, cacheWriteInputTokens: 1_000, outputTokens: 0 });
    expect(write.estimatedProviderCostUsd).toBe(writePrice / 1_000);
    expect(cached.provider).toBe('openai');
  });

  it('applies the long-context rate to the full request only above 272K input tokens', () => {
    expect(estimateUsageCharge({ model: 'gpt-6-sol', inputTokens: 272_000, outputTokens: 1_000 }).estimatedProviderCostUsd).toBe(0.554);
    expect(estimateUsageCharge({ model: 'gpt-6-sol', inputTokens: 272_001, outputTokens: 1_000 }).estimatedProviderCostUsd).toBe(1.103004);
  });

  it('caps cache subsets at total input tokens instead of double-charging malformed metadata', () => {
    expect(estimateUsageCharge({ model: 'gpt-6-luna', inputTokens: 100, cachedInputTokens: 200, cacheWriteInputTokens: 500, outputTokens: 0 })).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 0,
      estimatedProviderCostUsd: 0.000001,
    });
  });

  it('does not apply a known model price to a similarly named unknown model', () => {
    expect(estimateUsageCharge({ model: 'gpt-6-luna-unknown', inputTokens: 1_000, outputTokens: 1_000 }).provider).toBe('unknown');
  });

  it('prices the production OpenAI model using current token rates', () => {
    expect(
      estimateUsageCharge({
        model: 'gpt-5.6-terra',
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toMatchObject({
      provider: 'openai',
      estimatedProviderCostUsd: 18.4,
      creditsCharged: 920,
    });
  });

  it('prices GPT-5.6 cache writes at 1.25 times uncached input', () => {
    expect(
      estimateUsageCharge({
        model: 'gpt-5.6-terra',
        inputTokens: 1_000_000,
        cacheWriteInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toMatchObject({
      estimatedProviderCostUsd: 5,
      creditsCharged: 250,
      cacheWriteInputTokens: 1_000_000,
    });
  });

  it('prices Kimi K2.6 using current Workers AI token rates', () => {
    expect(
      estimateUsageCharge({
        model: '@cf/moonshotai/kimi-k2.6',
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toMatchObject({
      provider: 'workers-ai',
      estimatedProviderCostUsd: 4.16,
      creditsCharged: 208,
    });
  });

  it('uses conservative fallback pricing for unknown models', () => {
    const charge = estimateUsageCharge({ model: 'future/model', inputTokens: 1_000, outputTokens: 1_000 });
    expect(charge.estimatedProviderCostUsd).toBe(0.018);
    expect(charge.creditsCharged).toBe(0.9);
  });

  it('uses a small fallback charge when a provider omits usage metadata', () => {
    expect(estimateUsageCharge({ model: '@cf/moonshotai/kimi-k2.6' })).toMatchObject({
      usageQuality: 'missing',
      estimatedProviderCostUsd: 0.002,
      creditsCharged: 0.1,
    });
  });

  it('combines multi-step tool-loop completions without losing precision', () => {
    const first = estimateUsageCharge({ model: '@cf/moonshotai/kimi-k2.6', inputTokens: 100, outputTokens: 20 });
    const second = estimateUsageCharge({ model: '@cf/moonshotai/kimi-k2.6', inputTokens: 500, outputTokens: 80 });
    expect(combineUsageCharges([first, second])).toMatchObject({
      inputTokens: 600,
      outputTokens: 100,
      estimatedProviderCostUsd: 0.00097,
      creditsCharged: 0.0485,
    });
  });

  it('uses the free and StuPro monthly grant sizes without excluding legacy free accounts', () => {
    expect(planMonthlyCredits('stuflo')).toBe(25);
    expect(planMonthlyCredits('free')).toBe(25);
    expect(planMonthlyCredits('stupro')).toBe(250);
  });

  it('sanitizes database-backed usage settings', () => {
    expect(
      normalizeUsageSettings({
        creditValueUsd: -1,
        stufloMonthlyCredits: 125,
        warningThresholds: [0.9, 0.2, 2],
      }),
    ).toMatchObject({
      creditValueUsd: 0.02,
      stufloMonthlyCredits: 125,
      warningThresholds: [0.5, 0.8, 0.95],
    });
  });

  it('classifies warning thresholds and zero-credit exhaustion', () => {
    expect(usageWarningLevel(100, 51)).toBe('ok');
    expect(usageWarningLevel(100, 50)).toBe('notice');
    expect(usageWarningLevel(100, 20)).toBe('warning');
    expect(usageWarningLevel(100, 5)).toBe('critical');
    expect(usageWarningLevel(100, 0)).toBe('exhausted');
  });
});
