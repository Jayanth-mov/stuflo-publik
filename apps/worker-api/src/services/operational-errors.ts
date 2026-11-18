import { GlobalUsageBudgetExceededError, UsageCreditsExhaustedError } from '@stuflo/usage';

export type StripeWebhookFailureCode =
  | 'stripe_event_mode_mismatch'
  | 'stripe_checkout_incomplete'
  | 'stripe_invoice_incomplete'
  | 'stripe_subscription_update_incomplete'
  | 'stripe_subscription_identity_mismatch'
  | 'stripe_subscription_cancellation_incomplete'
  | 'stripe_subscription_price_missing'
  | 'stripe_subscription_price_unrecognized'
  | 'stripe_api_request_failed'
  | 'stripe_webhook_processing_failed';

// Store identifiers needed to investigate a delivery, never the webhook body,
// customer email, payment details, or authentication material.
export type StripeWebhookErrorContext = {
  stripeEventId: string;
  stripeEventType: string;
  stripeLiveMode: boolean;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;
  stripeMissingFields?: string;
  stripeApiStatus?: number;
};

export class StripeWebhookProcessingError extends Error {
  constructor(
    readonly code: StripeWebhookFailureCode,
    message: string,
    readonly operationalContext: StripeWebhookErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StripeWebhookProcessingError';
  }
}

export function expectedUsageLimitMessage(error: unknown): string | null {
  if (error instanceof UsageCreditsExhaustedError) {
    return 'You have used all your StuFlo credits for this billing period. Check Usage in your dashboard for your allowance, or Billing if you want to upgrade.';
  }
  if (error instanceof GlobalUsageBudgetExceededError) {
    return `StuFlo has reached its ${error.period} AI usage limit. Please try again after the ${error.period === 'daily' ? 'daily' : 'monthly'} limit resets.`;
  }
  return null;
}
