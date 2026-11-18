import { redirect } from 'next/navigation';
import PublikGate from '@/components/PublikGate';
import { requireDashboardSession } from '@/lib/dashboard-session';
import { readPublikStatus } from '@/lib/publik-server';

export const metadata = { title: 'Connect Publik | StuFlo', robots: { index: false, follow: false } };

export default async function PublikPage({ searchParams }: { searchParams: Promise<{ settings?: string }> }) {
  const settings = (await searchParams).settings === '1';
  const hasSession = await requireDashboardSession();
  const status = hasSession ? await readPublikStatus() : { state: 'unreachable' as const };
  if (status.state === 'disabled' || (status.state === 'ready' && !settings)) redirect('/dashboard');
  return <PublikGate initialStatus={status} settings={settings} />;
}
