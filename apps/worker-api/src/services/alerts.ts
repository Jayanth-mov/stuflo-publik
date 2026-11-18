import {
  upsertOperationalAlert,
  type StufloDatabase,
} from '@stuflo/db';
import type { UsageSettings } from '@stuflo/usage';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';
import { expectedUsageLimitMessage, StripeWebhookProcessingError } from './operational-errors';

type CostSnapshot = {
  day: { costUsd: number; events: number };
  month: { costUsd: number; events: number };
};

function periodKey(period: 'daily' | 'monthly', now: Date) {
  return period === 'daily' ? now.toISOString().slice(0, 10) : now.toISOString().slice(0, 7);
}

export async function evaluateCostBudgets(
  db: StufloDatabase,
  settings: UsageSettings,
  costs: CostSnapshot,
  now = new Date(),
) {
  const periods = [
    { name: 'daily' as const, cost: costs.day.costUsd, budget: settings.dailyAiBudgetUsd },
    { name: 'monthly' as const, cost: costs.month.costUsd, budget: settings.monthlyAiBudgetUsd },
  ];
  for (const period of periods) {
    const ratio = period.budget > 0 ? period.cost / period.budget : 0;
    for (const threshold of settings.budgetWarningThresholds) {
      if (ratio < threshold) continue;
      const percentage = Math.round(threshold * 100);
      const severity = threshold >= 1 ? 'critical' : threshold >= 0.8 ? 'warning' : 'notice';
      const title = `${period.name === 'daily' ? 'Daily' : 'Monthly'} AI budget ${percentage}% threshold`;
      const message = `Estimated AI cost is $${period.cost.toFixed(4)} of the $${period.budget.toFixed(2)} ${period.name} budget.`;
      await upsertOperationalAlert(db, {
        dedupeKey: `ai-budget:${period.name}:${periodKey(period.name, now)}:${percentage}`,
        type: 'ai_cost_budget',
        severity,
        title,
        message,
        metadata: {
          period: period.name,
          threshold,
          costUsd: period.cost,
          budgetUsd: period.budget,
        },
      });
    }
  }
  return {
    dailyExceeded: costs.day.costUsd >= settings.dailyAiBudgetUsd,
    monthlyExceeded: costs.month.costUsd >= settings.monthlyAiBudgetUsd,
  };
}

export async function reportOperationalError(
  env: StufloEnv,
  request: Request,
  error: unknown,
  context: Record<string, string | number | boolean | undefined> = {},
) {
  // Quota enforcement is an expected product response. Company budget
  // thresholds already have their own alerts from evaluateCostBudgets.
  if (expectedUsageLimitMessage(error)) return;
  if (!env.HYPERDRIVE && !env.DATABASE_URL) return;
  const url = new URL(request.url);
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const errorMessage = error instanceof Error ? error.message.slice(0, 500) : 'Unexpected server error.';
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const causeName = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : undefined;
  const causeCode = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
  const stripeError = error instanceof StripeWebhookProcessingError ? error : null;
  const fingerprintBytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `${request.method}:${url.pathname}:${errorName}:${errorMessage}:${JSON.stringify(context)}`,
    ),
  );
  const fingerprint = Array.from(new Uint8Array(fingerprintBytes).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const opened = openDatabase(env);
  try {
    await upsertOperationalAlert(opened.db, {
      // Stripe retries one delivery across multiple days. Keep that delivery
      // as one incident instead of opening another row each UTC day.
      dedupeKey: stripeError
        ? `stripe-webhook:${stripeError.operationalContext.stripeEventId}:${stripeError.code}`
        : `worker-error:${new Date().toISOString().slice(0, 10)}:${fingerprint}`,
      type: stripeError ? 'stripe_webhook_error' : 'worker_error',
      severity: 'critical',
      title: stripeError ? 'Stripe webhook processing failed' : 'Worker request failed',
      message: stripeError
        ? `${stripeError.message} Event: ${stripeError.operationalContext.stripeEventId}.`
        : `${request.method} ${url.pathname}: ${errorName}`,
      metadata: {
        method: request.method,
        path: url.pathname,
        errorName,
        errorMessage,
        causeName,
        causeCode,
        fingerprint,
        ...context,
        ...(stripeError ? { errorCode: stripeError.code, ...stripeError.operationalContext } : {}),
      },
    });
  } finally {
    await opened.close();
  }
}
