export interface StripeWebhookEvent {
  id: string;
  type: string;
  livemode: boolean;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface StripeClientOptions {
  secretKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

export class StripeApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
  }
}

export class StripeWebhookVerificationError extends Error {
  constructor(message = 'Invalid Stripe webhook signature.') {
    super(message);
    this.name = 'StripeWebhookVerificationError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left.toLowerCase());
  const rightBytes = new TextEncoder().encode(right.toLowerCase());
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

export async function signStripePayload(
  payload: string,
  timestamp: number,
  endpointSecret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(endpointSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  endpointSecret: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<StripeWebhookEvent> {
  if (!endpointSecret || !signatureHeader) throw new StripeWebhookVerificationError();
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const component of signatureHeader.split(',')) {
    const separator = component.indexOf('=');
    if (separator < 0) continue;
    const key = component.slice(0, separator).trim();
    const value = component.slice(separator + 1).trim();
    if (key === 't') timestamps.push(value);
    if (key === 'v1') signatures.push(value);
  }
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) {
    throw new StripeWebhookVerificationError();
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const toleranceSeconds = Math.max(1, options.toleranceSeconds ?? 300);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new StripeWebhookVerificationError(
      'Stripe webhook timestamp is outside the allowed tolerance.',
    );
  }
  const expected = await signStripePayload(rawBody, timestamp, endpointSecret);
  if (!signatures.some((signature) => constantTimeEqualHex(signature, expected))) {
    throw new StripeWebhookVerificationError();
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new StripeWebhookVerificationError('Invalid Stripe webhook payload.');
  }
  if (!event || typeof event !== 'object') {
    throw new StripeWebhookVerificationError('Invalid Stripe webhook payload.');
  }
  const candidate = event as Partial<StripeWebhookEvent>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.type !== 'string' ||
    typeof candidate.livemode !== 'boolean' ||
    !candidate.data ||
    typeof candidate.data.object !== 'object' ||
    !candidate.data.object
  ) {
    throw new StripeWebhookVerificationError('Invalid Stripe webhook payload.');
  }
  return candidate as StripeWebhookEvent;
}

export class StripeClient {
  private readonly options: StripeClientOptions;

  constructor(options: StripeClientOptions) {
    if (!options.secretKey) throw new Error('Stripe secret key is required.');
    this.options = options;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const fetcher = this.options.fetch ?? fetch;
    const response = await fetcher(`${this.options.apiBase || 'https://api.stripe.com'}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...init.headers,
      },
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    } & T;
    if (!response.ok) {
      throw new StripeApiError(payload.error?.message || `Stripe returned HTTP ${response.status}.`, response.status);
    }
    return payload;
  }

  createCheckoutSession(input: {
    userId?: string;
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    plan: 'stuflo' | 'stupro';
    trialPeriodDays?: number;
  }) {
    if (input.trialPeriodDays !== undefined &&
      (!Number.isInteger(input.trialPeriodDays) || input.trialPeriodDays < 1 || input.trialPeriodDays > 730)) {
      throw new Error('Invalid subscription trial length.');
    }
    const body = new URLSearchParams({
      mode: 'subscription',
      customer: input.customerId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: 'true',
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': '1',
      'metadata[kind]': 'subscription',
      'metadata[plan]': input.plan,
      'subscription_data[metadata][plan]': input.plan,
    });
    if (input.userId) {
      body.set('client_reference_id', input.userId);
      body.set('metadata[stuflo_user_id]', input.userId);
      body.set('subscription_data[metadata][stuflo_user_id]', input.userId);
    }
    if (input.trialPeriodDays) {
      body.set('subscription_data[trial_period_days]', String(input.trialPeriodDays));
      body.set('payment_method_collection', 'always');
      body.set('subscription_data[trial_settings][end_behavior][missing_payment_method]', 'cancel');
    }
    return this.request<{ id: string; url: string | null }>('/v1/checkout/sessions', {
      method: 'POST',
      body,
      ...(input.userId ? { headers: { 'idempotency-key': `stuflo-checkout/${input.userId}/${input.priceId}/${input.trialPeriodDays ? `trial-${input.trialPeriodDays}` : 'paid'}/${Math.floor(Date.now() / 1_200_000)}` } } : {}),
    });
  }

  createPortalSession(customerId: string, returnUrl: string) {
    return this.request<{ id: string; url: string }>('/v1/billing_portal/sessions', {
      method: 'POST',
      body: new URLSearchParams({ customer: customerId, return_url: returnUrl }),
    });
  }

  retrieveSubscription(subscriptionId: string) {
    return this.request<Record<string, unknown>>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=items.data.price`,
    );
  }

  createCustomer(input: { email: string; name?: string | null; stufloUserId: string }) {
    const body = new URLSearchParams({
      email: input.email,
      'metadata[stuflo_user_id]': input.stufloUserId,
    });
    if (input.name?.trim()) body.set('name', input.name.trim());
    return this.request<{ id: string }>('/v1/customers', { method: 'POST', body,
      headers: { 'idempotency-key': `stuflo-customer/${input.stufloUserId}` } });
  }

  retrievePrice(priceId: string) {
    return this.request<Record<string, unknown>>(
      `/v1/prices/${encodeURIComponent(priceId)}`,
    );
  }

  retrieveCustomer(customerId: string) {
    return this.request<Record<string, unknown>>(
      `/v1/customers/${encodeURIComponent(customerId)}`,
    );
  }

  deleteCustomer(customerId: string) {
    return this.request<{ id: string; deleted: boolean }>(
      `/v1/customers/${encodeURIComponent(customerId)}`,
      { method: 'DELETE' },
    );
  }

  listInvoices(customerId: string, limit = 24) {
    const query = new URLSearchParams({
      customer: customerId,
      limit: String(Math.max(1, Math.min(Math.trunc(limit), 100))),
    });
    return this.request<{ data: Array<Record<string, unknown>> }>(`/v1/invoices?${query}`);
  }
}
