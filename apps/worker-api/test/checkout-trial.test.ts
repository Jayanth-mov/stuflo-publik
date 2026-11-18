import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), customer: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@stuflo/db')>(),
  getBillingSummaryByUserId: mocks.summary,
  getStripeCustomerByUserId: mocks.customer,
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
import { createCheckout, publicPlanPricing, TrialUnavailableError } from '../src/services/billing';
import type { StufloEnv } from '../src/env';

const env = { STRIPE_SECRET_KEY: 'sk_test_value', STRIPE_STUPRO_MONTHLY_PRICE_ID: 'price_month',
  STRIPE_STUPRO_YEARLY_PRICE_ID: 'price_year', APP_ORIGIN: 'https://app.stuflo.com' } as StufloEnv;

describe('Account-first StuPro trial checkout', () => {
  const fetcher = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summary.mockResolvedValue({ subscriptions: [], stripeCustomerId: 'cus_trial' });
    mocks.customer.mockResolvedValue({ stripeCustomerId: 'cus_trial' });
    fetcher.mockImplementation(async (url: string) => {
      if (url.includes('/prices/')) {
        const yearly = url.endsWith('price_year');
        return Response.json({ id: yearly ? 'price_year' : 'price_month', active: true, currency: 'usd',
          unit_amount: yearly ? 8400 : 900, recurring: { interval: yearly ? 'year' : 'month' } });
      }
      return Response.json({ id: 'cs_test', url: 'https://checkout.stripe.com/test' });
    });
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['monthly', 'yearly'] as const)('uses the current %s price and server-fixed trial duration', async (interval) => {
    await expect(createCheckout(env, { userId: 'user_trial', plan: 'stupro', interval, trial: true }))
      .resolves.toEqual({ url: 'https://checkout.stripe.com/test' });
    const request = fetcher.mock.calls.find(([url]) => url.endsWith('/checkout/sessions'))![1];
    const body = request.body as URLSearchParams;
    expect(body.get('line_items[0][price]')).toBe(interval === 'yearly' ? 'price_year' : 'price_month');
    expect(body.get('subscription_data[trial_period_days]')).toBe('10');
    expect(request.headers['idempotency-key']).toContain('/trial-10/');
    expect(body.get('client_reference_id')).toBe('user_trial');
  });

  it('publishes the 10-day trial with current monthly and yearly pricing', async () => {
    await expect(publicPlanPricing(env)).resolves.toMatchObject({
      stupro: {
        trialDays: 10,
        monthly: { amount: 900, interval: 'month', available: true },
        yearly: { amount: 8400, interval: 'year', available: true },
      },
    });
  });

  it('keeps the published trial duration consistent when Stripe pricing is unavailable', async () => {
    await expect(publicPlanPricing({} as StufloEnv)).resolves.toMatchObject({
      stupro: { trialDays: 10 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a repeat trial before creating Stripe checkout, without silently charging', async () => {
    mocks.summary.mockResolvedValue({ subscriptions: [{ plan: 'stupro', status: 'canceled' }] });
    await expect(createCheckout(env, { userId: 'user_trial', plan: 'stupro', interval: 'monthly', trial: true }))
      .rejects.toThrow(new TrialUnavailableError('The 10-day trial is for first-time StuPro subscribers. Continue without a trial to upgrade.'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['monthly', 'yearly'] as const)('keeps the normal paid %s checkout when the trial toggle is off', async (interval) => {
    await createCheckout(env, { userId: 'user_trial', plan: 'stupro', interval, trial: false });
    const request = fetcher.mock.calls.find(([url]) => url.endsWith('/checkout/sessions'))![1];
    expect((request.body as URLSearchParams).has('subscription_data[trial_period_days]')).toBe(false);
    expect(request.headers['idempotency-key']).toContain('/paid/');
  });
});
