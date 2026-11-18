import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USAGE_SETTINGS, GlobalUsageBudgetExceededError, UsageCreditsExhaustedError } from '@stuflo/usage';

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), open: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@stuflo/db')>(),
  upsertOperationalAlert: mocks.upsert,
}));
vi.mock('../src/services/database', () => ({ openDatabase: mocks.open }));

import { evaluateCostBudgets, reportOperationalError } from '../src/services/alerts';
import { expectedUsageLimitMessage, StripeWebhookProcessingError } from '../src/services/operational-errors';
import type { StufloEnv } from '../src/env';

const env = { DATABASE_URL: 'postgres://unused.test/stuflo' } as StufloEnv;
const chatRequest = new Request('https://api.stuflo.com/v1/chat', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockReturnValue({ db: {}, close: mocks.close });
});
afterEach(() => vi.useRealTimers());

describe('Expected usage limits', () => {
  it.each([
    new UsageCreditsExhaustedError(),
    new GlobalUsageBudgetExceededError('daily'),
    new GlobalUsageBudgetExceededError('monthly'),
  ])('does not open a critical Worker incident for %s', async (error) => {
    await reportOperationalError(env, chatRequest, error);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('explains the StuFlo allowance instead of suggesting a failed model retry', () => {
    expect(expectedUsageLimitMessage(new UsageCreditsExhaustedError())).toContain('StuFlo credits');
    expect(expectedUsageLimitMessage(new UsageCreditsExhaustedError())).not.toContain('try again');
    expect(expectedUsageLimitMessage(new Error('Provider disconnected'))).toBeNull();
  });

  it('still records the dedicated company budget threshold alerts', async () => {
    await expect(evaluateCostBudgets({} as never, DEFAULT_USAGE_SETTINGS, {
      day: { costUsd: 25, events: 1 }, month: { costUsd: 25, events: 1 },
    }, new Date('2026-10-01T12:00:00Z'))).resolves.toEqual({ dailyExceeded: true, monthlyExceeded: false });
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.upsert).toHaveBeenCalledWith({}, expect.objectContaining({
      type: 'ai_cost_budget', severity: 'critical', dedupeKey: 'ai-budget:daily:2026-10-01:100',
    }));
  });
});

describe('Operational incidents', () => {
  it('keeps unexpected model failures visible', async () => {
    await reportOperationalError(env, chatRequest, new Error('Provider disconnected'));
    expect(mocks.upsert).toHaveBeenCalledWith({}, expect.objectContaining({
      type: 'worker_error', severity: 'critical',
      metadata: expect.objectContaining({ path: '/v1/chat', errorMessage: 'Provider disconnected' }),
    }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('deduplicates one failed Stripe delivery across retry days with useful identifiers', async () => {
    const request = new Request('https://api.stuflo.com/v1/billing/webhook', { method: 'POST' });
    const error = new StripeWebhookProcessingError('stripe_subscription_price_unrecognized', 'Unknown Stripe price.', {
      stripeEventId: 'evt_retry', stripeEventType: 'customer.subscription.updated', stripeLiveMode: true,
      stripeCustomerId: 'cus_fixture', stripeSubscriptionId: 'sub_fixture', stripePriceId: 'price_fixture',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    await reportOperationalError(env, request, error);
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    await reportOperationalError(env, request, error);
    for (const [, row] of mocks.upsert.mock.calls) {
      expect(row).toMatchObject({
        dedupeKey: 'stripe-webhook:evt_retry:stripe_subscription_price_unrecognized',
        type: 'stripe_webhook_error', severity: 'critical',
        message: 'Unknown Stripe price. Event: evt_retry.',
        metadata: { errorCode: error.code, ...error.operationalContext },
      });
    }
  });
});
