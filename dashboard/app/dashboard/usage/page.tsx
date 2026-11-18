export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { workerApiJson } from '@/lib/worker-api';
import SettingsNav from '@/components/dashboard/SettingsNav';
import { CreditCard, History, Zap } from 'lucide-react';
import Link from 'next/link';

type UsageStatus = {
  plan: string;
  planCredits: number;
  creditsGranted: number;
  creditsUsed: number;
  creditsRemaining: number;
  warningLevel: string;
  recentEvents: Array<{
    id: string;
    createdAt: string;
    model: string | null;
    operation: string;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedProviderCostUsd: string | number | null;
    creditsCharged: string | number | null;
    metadata?: { channel?: string; usageQuality?: string };
  }>;
};

function formatCredits(value: number) {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value - Math.round(value)) < 0.05) return String(Math.round(value));
  return value.toFixed(1);
}

function formatDate(value: unknown) {
  if (!value) return '';
  return new Date(String(value)).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ProgressBar({ used, total, level }: { used: number; total: number; level: string }) {
  const percentage = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 100;
  const color =
    level === 'exhausted' || level === 'critical'
      ? 'bg-danger-600'
      : level === 'warning'
        ? 'bg-amber-500'
        : 'bg-primary-500';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-base">
        <span className="font-medium text-fg2">Credit usage</span>
        <span className="text-fg3">{percentage}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-surface-tint">
        <div
          className={`h-2 rounded-full transition-all ${color}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function StatusMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <SettingsNav active="usage" />
      <div className="rounded-2xl border border-line bg-surface p-6 text-center text-base text-fg3">
        {children}
      </div>
    </div>
  );
}

export default async function UsagePage() {
  let status: UsageStatus | null = null;
  let loadFailed = false;
  try {
    status = await workerApiJson<UsageStatus>('/v1/usage/status');
  } catch (error) {
    console.error('Usage page error:', error);
    loadFailed = true;
  }

  if (loadFailed) {
    return <StatusMessage>Something went wrong loading usage data. Please try refreshing the page.</StatusMessage>;
  }
  if (!status) return <StatusMessage>No StuFlo account found for this session.</StatusMessage>;

  const planName = status.plan === 'stupro' ? 'StuPro' : 'StuFlo Free';
  const total = status.creditsGranted || status.planCredits;
  const used = status.creditsUsed;

  return (
    <div className="space-y-6">
      <SettingsNav active="usage" />

      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-surface-tint px-3 py-1 text-xs font-semibold text-fg2">
              <Zap className="h-3.5 w-3.5" strokeWidth={1.85} />
              {planName} credits
            </div>
            <h2 className="text-2xl font-bold text-fg1">
              {formatCredits(status.creditsRemaining)} credits left
            </h2>
            <p className="mt-1 text-base text-fg3">
              {formatCredits(used)} used of {formatCredits(total)} available this period.
            </p>
            <p className="mt-1 text-sm text-fg3">
              Credits reset on the first day of each month and do not roll over.
            </p>
          </div>
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-4 py-2.5 text-base font-medium text-white transition-colors hover:bg-primary-600"
          >
            <CreditCard className="h-4 w-4" strokeWidth={1.85} />
            Manage billing
          </Link>
        </div>

        <div className="mt-6">
          <ProgressBar used={used} total={total} level={status.warningLevel} />
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <History className="h-4 w-4 text-fg3" strokeWidth={1.85} />
          <h3 className="text-base font-semibold text-fg1">Recent usage</h3>
        </div>

        {status.recentEvents.length === 0 ? (
          <p className="text-base text-fg3">No credit usage recorded yet this period.</p>
        ) : (
          <div className="divide-y divide-line">
            {status.recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-base font-medium text-fg1">{event.model || 'AI chat'}</p>
                  <p className="text-sm text-fg3">
                    {formatDate(event.createdAt)} · {event.metadata?.channel || 'web'} ·{' '}
                    {event.inputTokens || 0} input / {event.outputTokens || 0} output tokens
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-base font-semibold text-fg1">
                    {formatCredits(Number(event.creditsCharged) || 0)} credits
                  </p>
                  <p className="text-sm text-fg3">
                    ${Number(event.estimatedProviderCostUsd || 0).toFixed(5)} estimated API cost
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
