import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signStripePayload, StripeWebhookVerificationError, type StripeWebhookEvent } from '@stuflo/billing';
import { DEFAULT_USAGE_SETTINGS } from '@stuflo/usage';

const mocks = vi.hoisted(() => ({ updated: vi.fn(), checkout: vi.fn(), settings: vi.fn(), open: vi.fn(), close: vi.fn(), fetch: vi.fn() }));
vi.mock('@stuflo/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@stuflo/db')>(),
  fulfillStripeSubscriptionUpdated: mocks.updated,
  fulfillStripeCheckout: mocks.checkout,
  getOrCreateUsageSettings: mocks.settings,
}));
vi.mock('../src/services/database', () => ({ openDatabase: mocks.open }));

import { handleStripeWebhook } from '../src/services/billing';
import { StripeWebhookProcessingError } from '../src/services/operational-errors';
import type { StufloEnv } from '../src/env';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_LIVE_MODE: 'true',
  STRIPE_STUPRO_MONTHLY_PRICE_ID: 'price_current', STRIPE_STUPRO_YEARLY_PRICE_ID: 'price_year',
  STRIPE_LEGACY_STUPRO_PRICE_IDS: 'price_fixture_legacy_pro_1,price_fixture_legacy_pro_2,price_fixture_legacy_pro_3',
} as StufloEnv;

function updateEvent(overrides: Record<string, unknown> = {}): StripeWebhookEvent {
  return {
    id: 'evt_update', type: 'customer.subscription.updated', livemode: true,
    data: { object: { id: 'sub_fixture', customer: 'cus_fixture', status: 'active',
      items: { data: [{ price: { id: 'price_current' } }] }, ...overrides } },
  };
}

async function requestFor(event: StripeWebhookEvent) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signStripePayload(body, timestamp, env.STRIPE_WEBHOOK_SECRET!);
  return new Request('https://api.stuflo.com/v1/billing/webhook', {
    method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockReturnValue({ db: {}, close: mocks.close });
  mocks.settings.mockResolvedValue({ value: DEFAULT_USAGE_SETTINGS });
  mocks.fetch.mockImplementation(async () => Response.json(updateEvent().data.object));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('Verified Stripe webhook classification', () => {
  it.each([{ id: 'price_current' }, 'price_current'])('accepts a configured price as an object or identifier: %j', async (price) => {
    const event = updateEvent({ items: { data: [{ price }] } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    await handleStripeWebhook(await requestFor(event), env);
    expect(mocks.updated).toHaveBeenCalledWith({}, expect.objectContaining({
      eventId: 'evt_update', subscriptionId: 'sub_fixture', priceId: 'price_current', plan: 'stupro', monthlyCredits: 250,
    }));
  });

  it('distinguishes a complete subscription with an unknown price and keeps identifiers without customer PII', async () => {
    const event = updateEvent({ items: { data: [{ price: 'price_legacy_unknown' }] },
      customer_email: 'private@example.test', metadata: { untrusted_note: 'Do not log me' } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    const error = await handleStripeWebhook(await requestFor(event), env).catch((failure) => failure);
    expect(error).toBeInstanceOf(StripeWebhookProcessingError);
    expect(error.code).toBe('stripe_subscription_price_unrecognized');
    expect(error.operationalContext).toEqual({
      stripeEventId: 'evt_update', stripeEventType: 'customer.subscription.updated', stripeLiveMode: true,
      stripeCustomerId: 'cus_fixture', stripeSubscriptionId: 'sub_fixture', stripePriceId: 'price_legacy_unknown',
    });
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it('identifies which required subscription fields are absent rather than labeling them unknown prices', async () => {
    const event = updateEvent({ customer: null, items: { data: [] } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    const error = await handleStripeWebhook(await requestFor(event), env)
      .catch((failure) => failure);
    expect(error).toMatchObject({ code: 'stripe_subscription_update_incomplete',
      operationalContext: { stripeEventId: 'evt_update', stripeSubscriptionId: 'sub_fixture',
        stripeMissingFields: 'customer,items.data[0].price' } });
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it('preserves the established current subscription Pro metadata mapping for legacy prices', async () => {
    const event = updateEvent({ metadata: { plan: 'pro' }, items: { data: [{ price: 'price_legacy' }] } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    await handleStripeWebhook(await requestFor(event), env);
    expect(mocks.updated).toHaveBeenCalledWith({}, expect.objectContaining({ priceId: 'price_legacy', plan: 'stupro' }));
  });

  it('does not infer a plan from an unrelated product or arbitrary metadata', async () => {
    const event = updateEvent({ metadata: { plan: 'gold' }, items: { data: [{ price: 'price_unrelated' }] } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    await expect(handleStripeWebhook(await requestFor(event), env))
      .rejects.toMatchObject({ code: 'stripe_subscription_price_unrecognized' });
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it('does not trust webhook identifiers or touch billing before signature verification', async () => {
    const request = new Request('https://api.stuflo.com/v1/billing/webhook', {
      method: 'POST', body: JSON.stringify(updateEvent()),
      headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=invalid` },
    });
    await expect(handleStripeWebhook(request, env)).rejects.toBeInstanceOf(StripeWebhookVerificationError);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it('captures the retrieved subscription price when checkout fulfillment cannot map it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      id: 'sub_fixture', items: { data: [{ price: 'price_unknown' }] },
    })));
    const event = { id: 'evt_checkout', type: 'checkout.session.completed', livemode: true,
      data: { object: { customer: 'cus_fixture', subscription: 'sub_fixture', customer_email: 'private@example.test' } },
    } satisfies StripeWebhookEvent;
    await expect(handleStripeWebhook(await requestFor(event), env)).rejects.toMatchObject({
      code: 'stripe_subscription_price_unrecognized', operationalContext: {
        stripeEventId: 'evt_checkout', stripeCustomerId: 'cus_fixture', stripeSubscriptionId: 'sub_fixture', stripePriceId: 'price_unknown',
      },
    });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it('forwards the current canceled state when an old legacy checkout is delivered again', async () => {
    const priceId = env.STRIPE_LEGACY_STUPRO_PRICE_IDS!.split(',')[0];
    mocks.fetch.mockResolvedValueOnce(Response.json({
      id: 'sub_fixture', customer: 'cus_fixture', status: 'canceled', items: { data: [{ price: priceId }] },
    }));
    const event = { id: 'evt_checkout_old', type: 'checkout.session.completed', livemode: true,
      data: { object: { customer: 'cus_fixture', subscription: 'sub_fixture', customer_email: 'private@example.test' } },
    } satisfies StripeWebhookEvent;
    await handleStripeWebhook(await requestFor(event), env);
    expect(mocks.checkout).toHaveBeenCalledWith({}, expect.objectContaining({
      subscriptionStatus: 'canceled', priceId, plan: 'stupro',
    }));
    expect(mocks.fetch).toHaveBeenCalledWith('https://api.stripe.com/v1/subscriptions/sub_fixture?expand[]=items.data.price',
      expect.not.objectContaining({ method: 'POST' }));
  });

  it('does not assume a retrieved checkout subscription is active when its status is missing', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({
      id: 'sub_fixture', customer: 'cus_fixture', items: { data: [{ price: 'price_current' }] },
    }));
    const event = { id: 'evt_checkout_missing_status', type: 'checkout.session.completed', livemode: true,
      data: { object: { customer: 'cus_fixture', subscription: 'sub_fixture', customer_email: 'private@example.test' } },
    } satisfies StripeWebhookEvent;
    await expect(handleStripeWebhook(await requestFor(event), env)).rejects.toMatchObject({
      code: 'stripe_checkout_incomplete', operationalContext: { stripeMissingFields: 'subscription.status' },
    });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it('records a provider API failure separately from unknown subscription prices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Stripe unavailable: private-provider-detail' } }, { status: 503 })));
    const event = { id: 'evt_checkout', type: 'checkout.session.completed', livemode: true,
      data: { object: { customer: 'cus_fixture', subscription: 'sub_fixture', customer_email: 'private@example.test' } },
    } satisfies StripeWebhookEvent;
    const error = await handleStripeWebhook(await requestFor(event), env).catch((failure) => failure);
    expect(error).toMatchObject({
      code: 'stripe_api_request_failed', operationalContext: { stripeApiStatus: 503, stripeEventId: 'evt_checkout' },
    });
    expect(error.message).toBe('Stripe API request failed (HTTP 503).');
    expect(error.cause).toEqual({ name: 'StripeApiError', code: undefined });
    expect(JSON.stringify(error)).not.toContain('private-provider-detail');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it.each(env.STRIPE_LEGACY_STUPRO_PRICE_IDS!.split(','))('maps only the verified legacy price %s to Pro', async (priceId) => {
    const event = updateEvent({ items: { data: [{ price: priceId }] }, metadata: { plan: 'standard' } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    await handleStripeWebhook(await requestFor(event), env);
    expect(mocks.updated).toHaveBeenCalledWith({}, expect.objectContaining({ priceId, plan: 'stupro' }));
  });

  it('does not guess legacy entitlement from a matching amount or product name', async () => {
    const event = updateEvent({ items: { data: [{ price: { id: 'price_not_allowlisted', unit_amount: 2900,
      product: { name: 'StuPro Legacy' } } }] } });
    mocks.fetch.mockResolvedValueOnce(Response.json(event.data.object));
    await expect(handleStripeWebhook(await requestFor(event), env))
      .rejects.toMatchObject({ code: 'stripe_subscription_price_unrecognized' });
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it('reconciles the latest canceled state instead of restoring an old active delivery', async () => {
    const priceId = env.STRIPE_LEGACY_STUPRO_PRICE_IDS!.split(',')[0];
    const event = updateEvent({ status: 'active', cancel_at_period_end: true, items: { data: [{ price: priceId }] } });
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...event.data.object, status: 'canceled', cancel_at_period_end: false }));
    await handleStripeWebhook(await requestFor(event), env);
    expect(mocks.fetch).toHaveBeenCalledWith('https://api.stripe.com/v1/subscriptions/sub_fixture?expand[]=items.data.price',
      expect.not.objectContaining({ method: 'POST' }));
    expect(mocks.updated).toHaveBeenCalledWith({}, expect.objectContaining({
      priceId, plan: 'stupro', subscriptionStatus: 'canceled', cancelAtPeriodEnd: false,
    }));
  });

  it('reads missing snapshot fields from the current subscription without guessing', async () => {
    await handleStripeWebhook(await requestFor(updateEvent({ items: { data: [] }, customer: undefined })), env);
    expect(mocks.updated).toHaveBeenCalledWith({}, expect.objectContaining({
      customerId: 'cus_fixture', priceId: 'price_current', subscriptionStatus: 'active',
    }));
  });

  it('does not apply an update if Stripe current-state retrieval is unavailable', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }));
    await expect(handleStripeWebhook(await requestFor(updateEvent()), env))
      .rejects.toMatchObject({ code: 'stripe_api_request_failed', operationalContext: { stripeEventId: 'evt_update' } });
    expect(mocks.updated).not.toHaveBeenCalled();
  });

  it('rejects a retrieved subscription that does not match the signed event identity', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ ...updateEvent().data.object, customer: 'cus_other' }));
    await expect(handleStripeWebhook(await requestFor(updateEvent()), env))
      .rejects.toMatchObject({ code: 'stripe_subscription_identity_mismatch' });
    expect(mocks.updated).not.toHaveBeenCalled();
  });
});
