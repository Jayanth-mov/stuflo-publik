'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

type UsageSettings = {
  creditValueUsd: number;
  stufloMonthlyCredits: number;
  stuproMonthlyCredits: number;
  warningThresholds: [number, number, number];
  dailyAiBudgetUsd: number;
  monthlyAiBudgetUsd: number;
  budgetWarningThresholds: [number, number, number];
};

function money(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(value);
}

export function UsageEconomicsControls({ settings }: { settings: UsageSettings }) {
  const router = useRouter();
  const [creditValue, setCreditValue] = useState(settings.creditValueUsd);
  const [stufloCredits, setStufloCredits] = useState(settings.stufloMonthlyCredits);
  const [stuproCredits, setStuproCredits] = useState(settings.stuproMonthlyCredits);
  const [daily, setDaily] = useState(settings.dailyAiBudgetUsd);
  const [monthly, setMonthly] = useState(settings.monthlyAiBudgetUsd);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const stufloAllowance = creditValue * stufloCredits;
  const stuproAllowance = creditValue * stuproCredits;
  const valid = [creditValue, stufloCredits, stuproCredits, daily, monthly].every(
    (value) => Number.isFinite(value) && value > 0,
  );

  async function save() {
    setSaving(true);
    setMessage('');
    const response = await fetch('/api/worker/admin/usage-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...settings,
        creditValueUsd: creditValue,
        stufloMonthlyCredits: stufloCredits,
        stuproMonthlyCredits: stuproCredits,
        dailyAiBudgetUsd: daily,
        monthlyAiBudgetUsd: monthly,
      }),
    });
    setSaving(false);
    setMessage(response.ok ? 'Usage economics updated.' : 'Could not update usage economics.');
    if (response.ok) router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-primary-200 bg-primary-50/60 p-4 dark:border-primary-900 dark:bg-primary-950/20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-fg1">Value of one StuFlo credit</p>
            <p className="text-sm text-fg3">
              A {money(0.01)} model call currently consumes {(0.01 / Math.max(creditValue, 0.0001)).toFixed(2)} credits.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-fg2">
            $ per credit
            <input
              type="number"
              min="0.0001"
              max="1"
              step="0.001"
              value={creditValue}
              onChange={(event) => setCreditValue(Number(event.target.value))}
              className="w-28 rounded-lg border border-line bg-surface px-3 py-2 text-fg1"
            />
          </label>
        </div>
        <input
          type="range"
          min="0.001"
          max="0.1"
          step="0.001"
          value={Math.min(0.1, Math.max(0.001, creditValue))}
          onChange={(event) => setCreditValue(Number(event.target.value))}
          aria-label="Value of one StuFlo credit in US dollars"
          className="mt-4 w-full accent-primary-500"
        />
        <div className="mt-2 flex justify-between text-xs text-fg3">
          <span>Tighter usage · $0.001</span>
          <span>More usage · $0.10</span>
        </div>
        <p className="mt-3 text-sm text-fg2">
          Raising this value makes credits last longer because the same provider cost consumes fewer credits. Lowering it makes every AI call consume more credits. The change applies to new usage immediately.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="rounded-lg bg-surface-tint p-4 text-sm font-medium text-fg2">
          Free monthly credits
          <input type="number" min="1" step="1" value={stufloCredits} onChange={(event) => setStufloCredits(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg1" />
          <span className="mt-2 block text-xs font-normal text-fg3">Maximum modeled allowance: {money(stufloAllowance, 4)} per student/month.</span>
        </label>
        <label className="rounded-lg bg-surface-tint p-4 text-sm font-medium text-fg2">
          StuPro monthly credits
          <input type="number" min="1" step="1" value={stuproCredits} onChange={(event) => setStuproCredits(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg1" />
          <span className="mt-2 block text-xs font-normal text-fg3">Maximum modeled allowance: {money(stuproAllowance, 4)} per student/month.</span>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium text-fg2">
          Daily company-wide hard stop (USD)
          <input type="number" min="0.01" step="0.01" value={daily} onChange={(event) => setDaily(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg1" />
        </label>
        <label className="text-sm font-medium text-fg2">
          Monthly company-wide hard stop (USD)
          <input type="number" min="0.01" step="0.01" value={monthly} onChange={(event) => setMonthly(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg1" />
        </label>
      </div>

      <div className="rounded-lg border border-line p-4 text-sm text-fg2">
        <p className="font-semibold text-fg1">How the controls connect</p>
        <p className="mt-1">Actual provider cost ÷ {money(creditValue, 4)} = credits charged to that student.</p>
        <p className="mt-1">
          If everyone fully used their allowance, the {money(monthly)} monthly hard stop could cover about{' '}
          <strong>{stufloAllowance > 0 ? Math.floor(monthly / stufloAllowance) : 0} StuFlo</strong> or{' '}
          <strong>{stuproAllowance > 0 ? Math.floor(monthly / stuproAllowance) : 0} StuPro</strong> full monthly allowances.
        </p>
        <p className="mt-1 text-xs text-fg3">Plan-credit changes apply to the next monthly grant; they do not rewrite credits already granted this month.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving || !valid} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-white hover:bg-primary-600 disabled:opacity-50">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save usage controls
        </button>
        {message && <p className="text-sm text-fg3">{message}</p>}
      </div>
    </div>
  );
}

export function ResolveAlertButton({ alertId }: { alertId: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  async function resolve() {
    setSaving(true);
    const response = await fetch(`/api/worker/admin/alerts/${encodeURIComponent(alertId)}/resolve`, { method: 'POST' });
    setSaving(false);
    if (response.ok) router.refresh();
  }
  return (
    <button type="button" onClick={() => void resolve()} disabled={saving} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-fg2 hover:bg-surface-tint disabled:opacity-50">
      {saving ? 'Resolving...' : 'Resolve'}
    </button>
  );
}
