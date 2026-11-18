import { describe, expect, it, vi } from 'vitest';
import { StripeClient, signStripePayload, verifyStripeWebhook } from '../src';

const event = JSON.stringify({
  id: 'evt_test_1',
  type: 'checkout.session.completed',
  livemode: false,
  data: { object: { id: 'cs_test_1' } },
});

describe('Stripe webhook verification', () => {
  it('verifies the raw payload, v1 signature, and timestamp tolerance', async () => {
    const timestamp = 1_800_000_000;
    const signature = await signStripePayload(event, timestamp, 'whsec_test');
    await expect(
      verifyStripeWebhook(event, `t=${timestamp},v0=fake,v1=${signature}`, 'whsec_test', {
        nowSeconds: timestamp + 60,
      }),
    ).resolves.toMatchObject({ id: 'evt_test_1', type: 'checkout.session.completed' });
  });

  it('accepts any matching v1 signature during secret rotation', async () => {
    const timestamp = 1_800_000_000;
    const signature = await signStripePayload(event, timestamp, 'whsec_test');
    await expect(
      verifyStripeWebhook(event, `t=${timestamp},v1=bad,v1=${signature}`, 'whsec_test', {
        nowSeconds: timestamp,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects stale and invalid signatures', async () => {
    const timestamp = 1_800_000_000;
    const signature = await signStripePayload(event, timestamp, 'whsec_test');
    await expect(
      verifyStripeWebhook(event, `t=${timestamp},v1=${signature}`, 'whsec_test', {
        nowSeconds: timestamp + 301,
      }),
    ).rejects.toThrow('tolerance');
    await expect(
      verifyStripeWebhook(event, `t=${timestamp},v1=bad`, 'whsec_test', { nowSeconds: timestamp }),
    ).rejects.toThrow('Invalid Stripe webhook signature');
  });
});

describe('StripeClient', () => {
  it('retrieves the server-configured subscription price', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: 'price_stupro',
      active: true,
      currency: 'usd',
      unit_amount: 1_500,
      recurring: { interval: 'month' },
    }));
    const client = new StripeClient({ secretKey: 'sk_test_value', fetch: fetcher });

    await expect(client.retrievePrice('price_stupro')).resolves.toMatchObject({
      unit_amount: 1_500,
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.stripe.com/v1/prices/price_stupro');
  });

  it('creates a Stripe customer for a free account upgrading in place', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'cus_new' }));
    const client = new StripeClient({ secretKey: 'sk_test_value', fetch: fetcher });

    await expect(client.createCustomer({
      email: 'student@example.com',
      name: 'Student',
      stufloUserId: 'user_123',
    })).resolves.toEqual({ id: 'cus_new' });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/customers');
    const body = init.body as URLSearchParams;
    expect(body.get('email')).toBe('student@example.com');
    expect(body.get('metadata[stuflo_user_id]')).toBe('user_123');
  });

  it('creates form-encoded Checkout sessions with server-selected prices', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/test' }));
    const client = new StripeClient({ secretKey: 'sk_test_value', fetch: fetcher });
    await client.createCheckoutSession({
      customerId: 'cus_123',
      priceId: 'price_server_selected',
      successUrl: 'https://app.stuflo.com/dashboard/billing?success=1',
      cancelUrl: 'https://app.stuflo.com/dashboard/billing',
      plan: 'stupro',
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk_test_value' });
    const body = init.body as URLSearchParams;
    expect(body.get('line_items[0][price]')).toBe('price_server_selected');
    expect(body.get('metadata[plan]')).toBe('stupro');
    expect(body.get('allow_promotion_codes')).toBe('true');
    expect(body.get('subscription_data[trial_period_days]')).toBeNull();
  });

  it('encodes a 10-day Stripe trial and separates trial and paid checkout retries', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'cs_test_trial', url: 'https://checkout.stripe.com/test' }));
    const client = new StripeClient({ secretKey: 'sk_test_value', fetch: fetcher });
    const input = { userId: 'user_trial', customerId: 'cus_trial', priceId: 'price_stupro',
      successUrl: 'https://app.stuflo.com/dashboard/billing', cancelUrl: 'https://app.stuflo.com/dashboard/billing', plan: 'stupro' as const };
    await client.createCheckoutSession({ ...input, trialPeriodDays: 10 });
    await client.createCheckoutSession(input);
    const trialRequest = fetcher.mock.calls[0][1];
    const body = trialRequest.body as URLSearchParams;
    expect(body.get('subscription_data[trial_period_days]')).toBe('10');
    expect(body.get('payment_method_collection')).toBe('always');
    expect(body.get('subscription_data[trial_settings][end_behavior][missing_payment_method]')).toBe('cancel');
    expect(trialRequest.headers['idempotency-key']).toContain('/trial-10/');
    expect(fetcher.mock.calls[1][1].headers['idempotency-key']).toContain('/paid/');
    expect(fetcher.mock.calls[1][1].headers['idempotency-key']).not.toBe(trialRequest.headers['idempotency-key']);
    expect(() => client.createCheckoutSession({ ...input, trialPeriodDays: -1 })).toThrow('Invalid subscription trial length');
  });

  it('deletes a Stripe customer through the authenticated API', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'cus_123', deleted: true }));
    const client = new StripeClient({ secretKey: 'sk_test_value', fetch: fetcher });

    await expect(client.deleteCustomer('cus_123')).resolves.toEqual({
      id: 'cus_123',
      deleted: true,
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/customers/cus_123');
    expect(init.method).toBe('DELETE');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk_test_value' });
  });
});
