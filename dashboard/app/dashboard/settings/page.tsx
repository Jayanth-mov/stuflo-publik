export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { Palette, UserRound, Zap } from 'lucide-react';
import { workerApiJson } from '@/lib/worker-api';
import { readPublikStatus } from '@/lib/publik-server';
import SettingsNav from '@/components/dashboard/SettingsNav';
import { ThemeToggleSettingsButton } from '@/components/dashboard/ThemeToggle';
import AccountSettingsClient from '@/components/dashboard/AccountSettingsClient';

function planLabel(plan?: string | null) {
  if (plan === 'stupro') return 'StuPro';
  return 'StuFlo Free';
}

export default async function SettingsPage() {
  const [session, publik] = await Promise.all([
    workerApiJson<{ user: { email: string; name: string | null; plan: string } }>('/v1/auth/session'),
    readPublikStatus(),
  ]);
  const name = session?.user.name || '';
  const displayEmail = session?.user.email || 'Not available';
  const plan = session?.user.plan || 'free';
  const displayPlan = planLabel(plan);

  return (
    <div className="space-y-6">
      <SettingsNav active="general" />

      <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <UserRound className="h-5 w-5 text-primary-500" strokeWidth={1.85} />
          <h2 className="text-xl font-bold text-fg1">Account</h2>
        </div>
        <AccountSettingsClient
          initialName={name}
          initialEmail={displayEmail}
          plan={plan}
          planLabel={displayPlan}
        />
      </section>

      {publik.state === 'ready' && (
        <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary-500" strokeWidth={1.85} />
            <h2 className="text-xl font-bold text-fg1">Publik</h2>
          </div>
          <p className="mb-3 text-base text-fg3">Manage your AI provider and app activity preferences.</p>
          <a href="/publik?settings=1" className="text-base font-semibold text-primary-600 underline">Manage Publik</a>
        </section>
      )}

      <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <Palette className="h-5 w-5 text-primary-500" strokeWidth={1.85} />
          <h2 className="text-xl font-bold text-fg1">Appearance</h2>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-base font-medium text-fg1">Theme</p>
            <p className="text-base text-fg3">Choose how StuFlo looks on this device.</p>
          </div>
          <ThemeToggleSettingsButton />
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <h2 className="mb-3 text-xl font-bold text-fg1">Legal</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <a
            href="https://www.stuflo.com/tos"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center rounded-lg border border-line bg-surface px-4 py-2.5 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint sm:w-auto"
          >
            Terms of Service
          </a>
          <a
            href="https://www.stuflo.com/privacy-policy"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center rounded-lg border border-line bg-surface px-4 py-2.5 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint sm:w-auto"
          >
            Privacy Policy
          </a>
        </div>
      </section>

    </div>
  );
}
