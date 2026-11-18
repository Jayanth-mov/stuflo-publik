import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USAGE_SETTINGS } from '@stuflo/usage';
import type { StufloEnv } from '../src/env';
import type { ModelCompletion } from '../src/model/model-gateway';

const mocks = vi.hoisted(() => ({ charge: vi.fn(), settings: vi.fn(), costs: vi.fn(), budgets: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', () => ({
  chargeStudentUsage: mocks.charge,
  getOrCreateUsageSettings: mocks.settings,
  getGlobalUsageCosts: mocks.costs,
  ensureMonthlyCreditGrant: vi.fn(),
  getStudentByKey: vi.fn(),
  getStudentUsageStatus: vi.fn(),
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
vi.mock('../src/services/alerts', () => ({ evaluateCostBudgets: mocks.budgets }));
import { recordStuAgentUsage } from '../src/services/usage';

describe('recovered model request billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({ value: DEFAULT_USAGE_SETTINGS });
    mocks.costs.mockResolvedValue({ daily: 0, monthly: 0 });
    mocks.charge.mockResolvedValue({ id: 'usage-event' });
    mocks.budgets.mockResolvedValue({});
  });

  it('prices each provider request separately before combining recovered usage', async () => {
    const attempt = { inputTokens: 200_000, outputTokens: 100 };
    const completion: ModelCompletion = {
      content: 'Recovered answer.', toolCalls: [], provider: 'openai', model: 'gpt-6-sol', durationMs: 100,
      usage: { inputTokens: 400_000, outputTokens: 200 },
      usageAttempts: [attempt, attempt],
    };
    const result = await recordStuAgentUsage({ DATABASE_URL: 'postgres://test' } as StufloEnv, {
      studentId: 'student_test', completions: [completion], channel: 'web', toolNames: [],
    });
    expect(result?.charge).toMatchObject({ inputTokens: 400_000, outputTokens: 200, estimatedProviderCostUsd: 0.802, creditsCharged: 40.1 });
    expect(mocks.charge).toHaveBeenCalledOnce();
    expect(mocks.charge).toHaveBeenCalledWith({}, expect.objectContaining({ estimatedProviderCostUsd: 0.802, metadata: expect.objectContaining({ requestCount: 2 }) }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
