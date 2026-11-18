import { describe, expect, it } from 'vitest';
import { STUPRO_TRIAL_DAYS, stuproTrialEligible, stripeInvoiceSubscriptionId, stripePriceSummary } from '../src/services/billing';

describe('StuPro trial eligibility', () => {
  it('offers a 10-day trial to accounts without a prior StuPro subscription', () => {
    expect(STUPRO_TRIAL_DAYS).toBe(10);
    expect(stuproTrialEligible([])).toBe(true);
    expect(stuproTrialEligible([{ plan: 'stuflo', status: 'canceled' }])).toBe(true);
    expect(stuproTrialEligible([{ plan: 'stupro', status: 'incomplete_expired' }])).toBe(true);
  });
  it('does not offer repeat trials to former paid or trial subscribers', () => {
    for (const status of ['active', 'trialing', 'canceled', 'past_due', 'unpaid', 'incomplete']) {
      expect(stuproTrialEligible([{ plan: 'stupro', status }])).toBe(false);
    }
  });
});

describe('Public Stripe price summaries', () => {
  it('includes the Stripe price id used by the public checkout', () => {
    expect(
      stripePriceSummary({
        id: 'price_current',
        active: true,
        unit_amount: 900,
        currency: 'usd',
        recurring: { interval: 'month' },
      }),
    ).toEqual({
      priceId: 'price_current',
      active: true,
      amount: 900,
      currency: 'usd',
      interval: 'month',
    });
  });

  it('summarizes the yearly StuPro price used by checkout', () => {
    expect(
      stripePriceSummary({
        id: 'price_yearly',
        active: true,
        unit_amount: 8_400,
        currency: 'usd',
        recurring: { interval: 'year' },
      }),
    ).toMatchObject({
      priceId: 'price_yearly',
      amount: 8_400,
      interval: 'year',
    });
  });
});

describe('Stripe invoice reconciliation', () => {
  it('reads legacy top-level subscription ids', () => {
    expect(stripeInvoiceSubscriptionId({ subscription: 'sub_legacy' })).toBe('sub_legacy');
  });

  it('reads current Stripe parent subscription details', () => {
    expect(
      stripeInvoiceSubscriptionId({
        parent: { subscription_details: { subscription: 'sub_current' } },
      }),
    ).toBe('sub_current');
  });

  it('returns null when the invoice is unrelated to a subscription', () => {
    expect(stripeInvoiceSubscriptionId({ parent: { type: 'quote_details' } })).toBeNull();
  });
});
