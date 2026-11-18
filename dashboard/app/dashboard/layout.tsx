import Sidebar from '@/components/dashboard/Sidebar';
import TimezoneReporter from '@/components/dashboard/TimezoneReporter';
import DashboardHeader from '@/components/dashboard/DashboardHeader';
import NavigationProgress from '@/components/dashboard/NavigationProgress';
import PublikActivity from '@/components/dashboard/PublikActivity';
import { requireDashboardSession } from '@/lib/dashboard-session';
import { readPublikStatus } from '@/lib/publik-server';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!await requireDashboardSession()) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-paper px-6 text-center">
        <div className="max-w-sm space-y-4">
          <h1 className="text-2xl font-bold text-fg1">We couldn’t load your dashboard.</h1>
          <p className="text-fg3">Your connection may be interrupted. Try again in a moment.</p>
          <a href="/dashboard" className="inline-flex rounded-xl bg-primary-500 px-5 py-3 font-semibold text-white hover:bg-primary-600">Try again</a>
        </div>
      </main>
    );
  }

  const publik = await readPublikStatus();
  if (publik.state !== 'disabled' && publik.state !== 'ready') redirect('/publik');

  return (
    <div className="sf-shell">
      <Suspense fallback={null}><NavigationProgress /></Suspense>
      {publik.state === 'ready' && publik.usage && <PublikActivity />}
      <TimezoneReporter />
      <Sidebar />
      <main className="sf-main-app">
        <DashboardHeader />
        <div className="sf-content">{children}</div>
      </main>
    </div>
  );
}
