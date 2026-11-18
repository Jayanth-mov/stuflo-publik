import {
  StripeApiError,
  StripeClient,
  verifyStripeWebhook,
  type StripeWebhookEvent,
} from '@stuflo/billing';
import {
  fulfillStripeCheckout,
  fulfillStripeInvoicePaid,
  fulfillStripeSubscriptionDeleted,
  fulfillStripeSubscriptionUpdated,
  getBillingIdentityByUserId,
  getBillingSummaryByUserId,
  getOrCreateUsageSettings,
  getStripeCustomerByCustomerId,
  getStripeCustomerByUserId,
  recordIgnoredStripeEvent,
  saveStripeCustomer,
} from '@stuflo/db';
import {
  DEFAULT_USAGE_SETTINGS,
  normalizeUsageSettings,
  planMonthlyCredits,
} from '@stuflo/usage';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';
import { StripeWebhookProcessingError, type StripeWebhookErrorContext } from './operational-errors';

type Plan = 'stuflo' | 'stupro';
type BillingInterval = 'monthly' | 'yearly';

const FREE_MONTHLY_CREDITS = 25;
const STUPRO_MONTHLY_CREDITS = 250;
const STUPRO_MONTHLY_AMOUNT_CENTS = 900;
const STUPRO_YEARLY_AMOUNT_CENTS = 8_400;
export const STUPRO_TRIAL_DAYS = 10;

export function stuproTrialEligible(subscriptions: Array<{ plan: string; status: string }>) {
  return !subscriptions.some((subscription) => subscription.plan === 'stupro' && subscription.status !== 'incomplete_expired');
}

export class TrialUnavailableError extends Error {}

function stringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function objectField(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = object[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function dateFromUnix(value: unknown): Date | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000) : null;
}

function stripeClient(env: StufloEnv): StripeClient {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe API is not configured.');
  return new StripeClient({ secretKey: env.STRIPE_SECRET_KEY });
}

export function stripePriceSummary(price: Record<string, unknown>) {
  const recurring = objectField(price, 'recurring');
  return {
    priceId: stringField(price, 'id'),
    active: price.active === true,
    amount: Number(price.unit_amount) || 0,
    currency: stringField(price, 'currency') || 'usd',
    interval: stringField(recurring, 'interval'),
  };
}

export async function publicPlanPricing(env: StufloEnv) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_STUPRO_MONTHLY_PRICE_ID) {
    const monthly = {
      priceId: null,
      active: false,
      amount: STUPRO_MONTHLY_AMOUNT_CENTS,
      currency: 'usd',
      interval: 'month',
      available: false,
    };
    const yearly = {
      priceId: null,
      active: false,
      amount: STUPRO_YEARLY_AMOUNT_CENTS,
      currency: 'usd',
      interval: 'year',
      available: false,
    };
    return {
      free: { monthlyCredits: FREE_MONTHLY_CREDITS, amount: 0, currency: 'usd' },
      stupro: {
        monthlyCredits: STUPRO_MONTHLY_CREDITS,
        trialDays: STUPRO_TRIAL_DAYS,
        ...monthly,
        monthly,
        yearly,
      },
    };
  }
  const monthlyPrice = stripePriceSummary(
    await stripeClient(env).retrievePrice(env.STRIPE_STUPRO_MONTHLY_PRICE_ID),
  );
  const yearlyPrice = env.STRIPE_STUPRO_YEARLY_PRICE_ID
    ? stripePriceSummary(
        await stripeClient(env).retrievePrice(env.STRIPE_STUPRO_YEARLY_PRICE_ID),
      )
    : {
        priceId: null,
        active: false,
        amount: STUPRO_YEARLY_AMOUNT_CENTS,
        currency: 'usd',
        interval: 'year',
      };
  const monthly = {
    ...monthlyPrice,
    available:
      monthlyPrice.active &&
      monthlyPrice.amount === STUPRO_MONTHLY_AMOUNT_CENTS &&
      monthlyPrice.currency === 'usd' &&
      monthlyPrice.interval === 'month',
  };
  const yearly = {
    ...yearlyPrice,
    available:
      yearlyPrice.active &&
      yearlyPrice.amount === STUPRO_YEARLY_AMOUNT_CENTS &&
      yearlyPrice.currency === 'usd' &&
      yearlyPrice.interval === 'year',
  };
  return {
    free: { monthlyCredits: FREE_MONTHLY_CREDITS, amount: 0, currency: 'usd' },
    stupro: {
      monthlyCredits: STUPRO_MONTHLY_CREDITS,
      trialDays: STUPRO_TRIAL_DAYS,
      ...monthly,
      monthly,
      yearly,
    },
  };
}

function expectedLiveMode(env: StufloEnv): boolean {
  return (env.STRIPE_LIVE_MODE as string | undefined) !== 'false';
}

function priceId(env: StufloEnv, plan: Plan, interval: BillingInterval): string {
  const key =
    plan === 'stupro'
      ? interval === 'yearly'
        ? env.STRIPE_STUPRO_YEARLY_PRICE_ID
        : env.STRIPE_STUPRO_MONTHLY_PRICE_ID
      : interval === 'yearly'
        ? env.STRIPE_STUFLO_YEARLY_PRICE_ID
        : env.STRIPE_STUFLO_MONTHLY_PRICE_ID;
  if (!key) throw new Error('The requested Stripe price is not configured.');
  return key;
}

function planForPrice(env: StufloEnv, candidate: string | null): Plan | null {
  if (!candidate) return null;
  const legacyProPrices = (env.STRIPE_LEGACY_STUPRO_PRICE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if ([env.STRIPE_STUPRO_MONTHLY_PRICE_ID, env.STRIPE_STUPRO_YEARLY_PRICE_ID, ...legacyProPrices].includes(candidate)) {
    return 'stupro';
  }
  if ([env.STRIPE_STUFLO_MONTHLY_PRICE_ID, env.STRIPE_STUFLO_YEARLY_PRICE_ID].includes(candidate)) {
    return 'stuflo';
  }
  return null;
}

function metadataPlan(object: Record<string, unknown>): Plan | null {
  const plan = objectField(object, 'metadata').plan;
  if (plan === 'stuflo' || plan === 'standard') return 'stuflo';
  if (plan === 'stupro' || plan === 'pro') return 'stupro';
  return null;
}

function firstSubscriptionItem(subscription: Record<string, unknown>): Record<string, unknown> {
  const items = objectField(subscription, 'items');
  const data = Array.isArray(items.data) ? items.data : [];
  return data[0] && typeof data[0] === 'object' ? (data[0] as Record<string, unknown>) : {};
}

export function stripeSubscriptionPriceId(subscription: Record<string, unknown>): string | null {
  // Stripe may supply an expanded Price object or just its identifier.
  return stringField(firstSubscriptionItem(subscription), 'price');
}

export function stripeInvoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  return (
    stringField(invoice, 'subscription') ||
    stringField(objectField(objectField(invoice, 'parent'), 'subscription_details'), 'subscription')
  );
}

function invoiceSummary(invoice: Record<string, unknown>) {
  return {
    id: stringField(invoice, 'id'),
    customerId: stringField(invoice, 'customer'),
    created: Number(invoice.created) || null,
    total: Number(invoice.total) || 0,
    amountPaid: Number(invoice.amount_paid) || 0,
    amountDue: Number(invoice.amount_due) || 0,
    currency: stringField(invoice, 'currency') || 'usd',
    status: stringField(invoice, 'status'),
    hostedInvoiceUrl: stringField(invoice, 'hosted_invoice_url'),
    invoicePdf: stringField(invoice, 'invoice_pdf'),
  };
}

function stripeDashboardBase(env: StufloEnv) {
  return expectedLiveMode(env) ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test';
}

async function settings(env: StufloEnv) {
  const opened = openDatabase(env);
  try {
    return normalizeUsageSettings(
      (await getOrCreateUsageSettings(opened.db, DEFAULT_USAGE_SETTINGS)).value,
    );
  } finally {
    await opened.close();
  }
}

export async function createCheckout(
  env: StufloEnv,
  input: { userId: string; plan: Plan; interval: BillingInterval; trial?: boolean },
) {
  if (input.plan !== 'stupro' || !['monthly', 'yearly'].includes(input.interval)) {
    throw new Error('Only StuPro monthly and yearly plans are available.');
  }
  const existing = openDatabase(env);
  try {
    const summary = await getBillingSummaryByUserId(existing.db, input.userId);
    if (summary.subscriptions.some((subscription) => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(subscription.status))) {
      return createPortal(env, input.userId);
    }
    if (input.trial && !stuproTrialEligible(summary.subscriptions)) {
      throw new TrialUnavailableError(`The ${STUPRO_TRIAL_DAYS}-day trial is for first-time StuPro subscribers. Continue without a trial to upgrade.`);
    }
  } finally { await existing.close(); }
  const planPricing = await publicPlanPricing(env);
  const selectedPrice = input.interval === 'yearly'
    ? planPricing.stupro.yearly
    : planPricing.stupro.monthly;
  if (!selectedPrice.available) {
    const expectedPrice = input.interval === 'yearly' ? '$84/year' : '$9/month';
    throw new Error(`StuPro checkout is temporarily unavailable because its Stripe price is not ${expectedPrice}.`);
  }
  const client = stripeClient(env);
  const opened = openDatabase(env);
  let customerId: string | null = null;
  let identity: { email: string; name: string | null } | null = null;
  try {
    const customer = await getStripeCustomerByUserId(opened.db, input.userId);
    customerId = customer?.stripeCustomerId || null;
    if (!customerId) identity = await getBillingIdentityByUserId(opened.db, input.userId);
  } finally {
    await opened.close();
  }
  if (!customerId) {
    if (!identity) throw new Error('StuFlo account does not exist.');
    const customer = await client.createCustomer({
      email: identity.email,
      name: identity.name,
      stufloUserId: input.userId,
    });
    customerId = customer.id;
    const saveOpened = openDatabase(env);
    try {
      await saveStripeCustomer(saveOpened.db, { userId: input.userId, stripeCustomerId: customerId });
    } finally {
      await saveOpened.close();
    }
  }
  const appOrigin = env.APP_ORIGIN || 'https://app.stuflo.com';
  const session = await client.createCheckoutSession({
    userId: input.userId,
    customerId,
    priceId: priceId(env, input.plan, input.interval),
    plan: input.plan,
    ...(input.trial ? { trialPeriodDays: STUPRO_TRIAL_DAYS } : {}),
    successUrl: `${appOrigin}/dashboard/billing?checkout=success`,
    cancelUrl: `${appOrigin}/dashboard/billing`,
  });
  if (!session.url) throw new Error('Stripe returned no Checkout URL.');
  return { url: session.url };
}

export async function createPortal(env: StufloEnv, userId: string) {
  const opened = openDatabase(env);
  let customerId: string;
  try {
    const customer = await getStripeCustomerByUserId(opened.db, userId);
    if (!customer) throw new Error('Stripe customer does not exist for this account.');
    customerId = customer.stripeCustomerId;
  } finally {
    await opened.close();
  }
  const appOrigin = env.APP_ORIGIN || 'https://app.stuflo.com';
  const session = await stripeClient(env).createPortalSession(
    customerId,
    `${appOrigin}/dashboard/billing`,
  );
  return { url: session.url };
}

export async function billingSummary(env: StufloEnv, userId: string) {
  const opened = openDatabase(env);
  let summary;
  try {
    summary = await getBillingSummaryByUserId(opened.db, userId);
  } finally {
    await opened.close();
  }
  const yearlyPrices = new Set([
    env.STRIPE_STUFLO_YEARLY_PRICE_ID,
    env.STRIPE_STUPRO_YEARLY_PRICE_ID,
  ]);
  const invoices = summary.stripeCustomerId
    ? (await stripeClient(env).listInvoices(summary.stripeCustomerId)).data.map(invoiceSummary)
    : [];
  return {
    ...summary,
    subscriptions: summary.subscriptions.map((subscription) => ({
      ...subscription,
      interval: yearlyPrices.has(subscription.priceId) ? 'yearly' : 'monthly',
    })),
    invoices,
  };
}

export async function adminStudentStripeSnapshot(env: StufloEnv, customerId: string) {
  const client = stripeClient(env);
  const [customer, invoices] = await Promise.all([
    client.retrieveCustomer(customerId),
    client.listInvoices(customerId, 12),
  ]);
  return {
    customerId,
    deleted: customer.deleted === true,
    delinquent: customer.delinquent === true,
    balance: Number(customer.balance) || 0,
    currency: stringField(customer, 'currency') || 'usd',
    created: Number(customer.created) || null,
    dashboardUrl: `${stripeDashboardBase(env)}/customers/${encodeURIComponent(customerId)}`,
    invoices: invoices.data.map(invoiceSummary),
  };
}

export async function deleteStripeCustomer(env: StufloEnv, customerId: string) {
  try {
    const result = await stripeClient(env).deleteCustomer(customerId);
    return { customerId: result.id, deleted: result.deleted === true, alreadyDeleted: false };
  } catch (error) {
    if (error instanceof StripeApiError && error.status === 404) {
      return { customerId, deleted: true, alreadyDeleted: true };
    }
    throw error;
  }
}

async function processEvent(env: StufloEnv, event: StripeWebhookEvent) {
  const context = stripeWebhookEventContext(event);
  if (event.livemode !== expectedLiveMode(env)) {
    throw new StripeWebhookProcessingError('stripe_event_mode_mismatch',
      'Stripe event live/test mode does not match this deployment.', context);
  }
  const object = event.data.object;
  const opened = openDatabase(env);
  try {
    if (event.type === 'checkout.session.completed') {
      const customerId = stringField(object, 'customer');
      const email =
        stringField(objectField(object, 'customer_details'), 'email') || stringField(object, 'customer_email');
      const subscriptionId = stringField(object, 'subscription');
      if (!customerId || !subscriptionId || !email) {
        throw new StripeWebhookProcessingError('stripe_checkout_incomplete',
          'Stripe Checkout event is missing required billing data.', {
            ...context,
            stripeMissingFields: [!customerId && 'customer', !subscriptionId && 'subscription', !email && 'customer_email'].filter(Boolean).join(','),
          });
      }
      const subscription = await stripeClient(env).retrieveSubscription(subscriptionId);
      const item = firstSubscriptionItem(subscription);
      const resolvedPriceId = stripeSubscriptionPriceId(subscription);
      const subscriptionStatus = stringField(subscription, 'status');
      const plan = planForPrice(env, resolvedPriceId) || metadataPlan(subscription) || metadataPlan(object);
      if (!resolvedPriceId) {
        throw new StripeWebhookProcessingError('stripe_subscription_price_missing',
          'Stripe subscription is missing its price.', context);
      }
      if (!plan) {
        throw new StripeWebhookProcessingError('stripe_subscription_price_unrecognized',
          'Stripe subscription price is not recognized.', { ...context, stripePriceId: resolvedPriceId });
      }
      if (!subscriptionStatus) {
        throw new StripeWebhookProcessingError('stripe_checkout_incomplete',
          'Current Stripe Checkout subscription is missing its status.', {
            ...context, stripePriceId: resolvedPriceId, stripeMissingFields: 'subscription.status',
          });
      }
      const usageSettings = await settings(env);
      return fulfillStripeCheckout(opened.db, {
        userId: stringField(object, 'client_reference_id') || undefined,
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        email,
        name: stringField(objectField(object, 'customer_details'), 'name'),
        studentKey: `student_${crypto.randomUUID().replace(/-/g, '')}`,
        customerId,
        subscriptionId,
        subscriptionStatus,
        priceId: resolvedPriceId,
        plan,
        currentPeriodStart: dateFromUnix(subscription.current_period_start ?? item.current_period_start),
        currentPeriodEnd: dateFromUnix(subscription.current_period_end ?? item.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        monthlyCredits: planMonthlyCredits(plan, usageSettings),
      });
    }
    if (event.type === 'invoice.paid') {
      const customerId = stringField(object, 'customer');
      if (!customerId) {
        throw new StripeWebhookProcessingError('stripe_invoice_incomplete',
          'Stripe invoice event is missing its customer.', { ...context, stripeMissingFields: 'customer' });
      }
      const usageSettings = await settings(env);
      const linkedCustomer = await getStripeCustomerByCustomerId(opened.db, customerId);
      if (!linkedCustomer) {
        const email = stringField(object, 'customer_email');
        const subscriptionId = stripeInvoiceSubscriptionId(object);
        if (!email || !subscriptionId) {
          throw new StripeWebhookProcessingError('stripe_invoice_incomplete',
            'Unlinked Stripe invoice is missing required billing data.', {
              ...context,
              stripeMissingFields: [!email && 'customer_email', !subscriptionId && 'subscription'].filter(Boolean).join(','),
            });
        }
        const subscription = await stripeClient(env).retrieveSubscription(subscriptionId);
        const item = firstSubscriptionItem(subscription);
        const resolvedPriceId = stripeSubscriptionPriceId(subscription);
        const subscriptionStatus = stringField(subscription, 'status');
        const plan = planForPrice(env, resolvedPriceId) || metadataPlan(subscription);
        if (!resolvedPriceId) {
          throw new StripeWebhookProcessingError('stripe_subscription_price_missing',
            'Unlinked Stripe invoice subscription is missing its price.', context);
        }
        if (!plan) {
          throw new StripeWebhookProcessingError('stripe_subscription_price_unrecognized',
            'Unlinked Stripe invoice uses an unrecognized subscription price.', { ...context, stripePriceId: resolvedPriceId });
        }
        if (!subscriptionStatus) {
          throw new StripeWebhookProcessingError('stripe_invoice_incomplete',
            'Current Stripe invoice subscription is missing its status.', {
              ...context, stripePriceId: resolvedPriceId, stripeMissingFields: 'subscription.status',
            });
        }
        return fulfillStripeCheckout(opened.db, {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          email,
          name: stringField(object, 'customer_name'),
          studentKey: `student_${crypto.randomUUID().replace(/-/g, '')}`,
          customerId,
          subscriptionId,
          subscriptionStatus,
          priceId: resolvedPriceId,
          plan,
          currentPeriodStart: dateFromUnix(subscription.current_period_start ?? item.current_period_start),
          currentPeriodEnd: dateFromUnix(subscription.current_period_end ?? item.current_period_end),
          cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
          monthlyCredits: planMonthlyCredits(plan, usageSettings),
        });
      }
      return fulfillStripeInvoicePaid(opened.db, {
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        customerId,
        stufloMonthlyCredits: usageSettings.stufloMonthlyCredits,
        stuproMonthlyCredits: usageSettings.stuproMonthlyCredits,
      });
    }
    if (event.type === 'customer.subscription.deleted') {
      const customerId = stringField(object, 'customer');
      const subscriptionId = stringField(object, 'id');
      if (!customerId || !subscriptionId) {
        throw new StripeWebhookProcessingError('stripe_subscription_cancellation_incomplete',
          'Stripe cancellation event is incomplete.', {
            ...context,
            stripeMissingFields: [!customerId && 'customer', !subscriptionId && 'id'].filter(Boolean).join(','),
          });
      }
      return fulfillStripeSubscriptionDeleted(opened.db, {
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        customerId,
        subscriptionId,
      });
    }
    if (event.type === 'customer.subscription.updated') {
      const subscriptionId = stringField(object, 'id');
      if (!subscriptionId) {
        throw new StripeWebhookProcessingError('stripe_subscription_update_incomplete',
          'Stripe subscription update is missing its subscription identifier.', { ...context, stripeMissingFields: 'id' });
      }
      // Stripe can deliver old updates after cancellation or a later plan
      // change. Reconcile the current subscription, never the old snapshot.
      const subscription = await stripeClient(env).retrieveSubscription(subscriptionId);
      const customerId = stringField(subscription, 'customer');
      const eventCustomerId = stringField(object, 'customer');
      if (stringField(subscription, 'id') !== subscriptionId || (eventCustomerId && customerId && eventCustomerId !== customerId)) {
        throw new StripeWebhookProcessingError('stripe_subscription_identity_mismatch',
          'Stripe subscription retrieval did not match the signed event identity.', context);
      }
      const item = firstSubscriptionItem(subscription);
      const resolvedPriceId = stripeSubscriptionPriceId(subscription);
      const subscriptionStatus = stringField(subscription, 'status');
      const currentContext = { ...context, stripeCustomerId: customerId || undefined, stripePriceId: resolvedPriceId || undefined };
      const plan = planForPrice(env, resolvedPriceId) || metadataPlan(subscription);
      if (!customerId || !resolvedPriceId || !subscriptionStatus) {
        throw new StripeWebhookProcessingError('stripe_subscription_update_incomplete',
          'Current Stripe subscription is missing required billing data.', {
            ...currentContext,
            stripeMissingFields: [!customerId && 'customer', !resolvedPriceId && 'items.data[0].price', !subscriptionStatus && 'status'].filter(Boolean).join(','),
          });
      }
      if (!plan) {
        throw new StripeWebhookProcessingError('stripe_subscription_price_unrecognized',
          'Current Stripe subscription uses an unrecognized price.', currentContext);
      }
      const usageSettings = await settings(env);
      return fulfillStripeSubscriptionUpdated(opened.db, {
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        customerId,
        subscriptionId,
        subscriptionStatus,
        priceId: resolvedPriceId,
        plan,
        currentPeriodStart: dateFromUnix(subscription.current_period_start ?? item.current_period_start),
        currentPeriodEnd: dateFromUnix(subscription.current_period_end ?? item.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        monthlyCredits: planMonthlyCredits(plan, usageSettings),
      });
    }
    return recordIgnoredStripeEvent(opened.db, {
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      reason: 'event_type_not_used',
    });
  } finally {
    await opened.close();
  }
}

function stripeWebhookEventContext(event: StripeWebhookEvent): StripeWebhookErrorContext {
  const object = event.data.object;
  return {
    stripeEventId: event.id,
    stripeEventType: event.type,
    stripeLiveMode: event.livemode,
    stripeCustomerId: stringField(object, 'customer') || undefined,
    stripeSubscriptionId: (event.type.startsWith('customer.subscription.')
      ? stringField(object, 'id')
      : stringField(object, 'subscription') || stripeInvoiceSubscriptionId(object)) || undefined,
    stripePriceId: stripeSubscriptionPriceId(object) || undefined,
  };
}

export async function handleStripeWebhook(request: Request, env: StufloEnv) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook is not configured.');
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 1_000_000) throw new Error('Stripe webhook body is too large.');
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 1_000_000) {
    throw new Error('Stripe webhook body is too large.');
  }
  const event = await verifyStripeWebhook(
    rawBody,
    request.headers.get('stripe-signature'),
    env.STRIPE_WEBHOOK_SECRET,
  );
  try {
    return await processEvent(env, event);
  } catch (error) {
    if (error instanceof StripeWebhookProcessingError) throw error;
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
    const causeCode = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code : undefined;
    throw new StripeWebhookProcessingError(
      error instanceof StripeApiError ? 'stripe_api_request_failed' : 'stripe_webhook_processing_failed',
      error instanceof StripeApiError
        ? `Stripe API request failed (HTTP ${error.status}).`
        : 'Verified Stripe webhook could not be fulfilled.',
      {
        ...stripeWebhookEventContext(event),
        ...(error instanceof StripeApiError ? { stripeApiStatus: error.status } : {}),
      },
      // Provider errors can echo credentials; query errors can echo bound
      // customer data. Keep the cause classification without either payload.
      { cause: { name: error instanceof Error ? error.name : 'UnknownError', code: causeCode } },
    );
  }
}
