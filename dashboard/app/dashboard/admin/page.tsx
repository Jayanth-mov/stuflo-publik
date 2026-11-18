export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Database,
  GraduationCap,
  Search,
} from 'lucide-react';
import {
  ResolveAlertButton,
  UsageEconomicsControls,
} from '@/components/dashboard/AdminControls';
import { workerApiJson } from '@/lib/worker-api';

type Overview = {
  studentCount: number;
  connectedCanvasCount: number;
  connectedGoogleCount: number;
  openAlertCount: number;
  usage: {
    day: { costUsd: number; events: number; averageDurationMs: number };
    month: { costUsd: number; events: number; averageDurationMs: number };
  };
  usageSettings: Parameters<typeof UsageEconomicsControls>[0]['settings'];
  alerts: Array<{
    id: string;
    title: string;
    message: string;
    severity: string;
    status: string;
    lastTriggeredAt: string;
  }>;
  recentAuditLogs: Array<{
    id: string;
    action: string;
    metadata: { targetStudentKey?: string; targetFingerprint?: string };
    createdAt: string;
  }>;
};

type Student = {
  id: string;
  studentKey: string;
  email: string;
  name: string | null;
  plan: string;
  status: string;
  createdAt: string;
  canvasStatus: string | null;
  googleStatus: string | null;
};

function money(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function percentage(cost: number, budget: number) {
  return budget > 0 ? Math.min(100, Math.max(0, (cost / budget) * 100)) : 0;
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const resolvedSearch = await searchParams;
  const query = resolvedSearch.q?.trim() || '';
  const page = Math.max(1, Number(resolvedSearch.page) || 1);
  const [overview, directory] = await Promise.all([
    workerApiJson<Overview>('/v1/admin/overview'),
    workerApiJson<{ students: Student[]; total: number; limit: number; offset: number }>(
      `/v1/admin/students?${new URLSearchParams({
        ...(query ? { q: query } : {}),
        page: String(page),
      })}`,
    ),
  ]);

  if (!overview || !directory) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-8 text-center text-fg3">
        Owner access is required.
      </div>
    );
  }

  const cards = [
    { label: 'Students', value: overview.studentCount, icon: GraduationCap },
    { label: 'Canvas connected', value: overview.connectedCanvasCount, icon: Database },
    { label: 'AI requests today', value: overview.usage.day.events, icon: Activity },
    { label: 'Open alerts', value: overview.openAlertCount, icon: AlertTriangle },
  ];
  const dailyPercentage = percentage(
    overview.usage.day.costUsd,
    overview.usageSettings.dailyAiBudgetUsd,
  );
  const monthlyPercentage = percentage(
    overview.usage.month.costUsd,
    overview.usageSettings.monthlyAiBudgetUsd,
  );
  const openAlerts = overview.alerts.filter((alert) => alert.status === 'open');

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wider text-primary-600">Owner console</p>
        <h1 className="text-3xl font-bold text-fg1">StuFlo operations</h1>
        <p className="mt-1 text-fg3">Students, connections, usage economics, alerts, and audited support access.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-5">
            <Icon className="mb-3 h-5 w-5 text-primary-500" />
            <p className="text-3xl font-bold text-fg1">{value}</p>
            <p className="text-sm text-fg3">{label}</p>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-fg1">AI usage and credit controls</h2>
            <p className="text-sm text-fg3">Today: {money(overview.usage.day.costUsd)} · This month: {money(overview.usage.month.costUsd)}</p>
            <p className="text-xs text-fg3">Average recorded model call today: {overview.usage.day.averageDurationMs > 0 ? `${(overview.usage.day.averageDurationMs / 1000).toFixed(1)}s` : 'awaiting new timing data'}</p>
          </div>
          <span className="rounded-full bg-surface-tint px-3 py-1 text-sm text-fg2">Metadata-only usage records</span>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-surface-tint p-4">
            <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium text-fg1">Daily hard stop</span><span className="text-fg3">{dailyPercentage.toFixed(1)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-primary-500" style={{ width: `${dailyPercentage}%` }} /></div>
            <p className="mt-2 text-xs text-fg3">New AI calls stop after recorded UTC-day cost reaches {money(overview.usageSettings.dailyAiBudgetUsd)}.</p>
          </div>
          <div className="rounded-lg bg-surface-tint p-4">
            <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium text-fg1">Monthly hard stop</span><span className="text-fg3">{monthlyPercentage.toFixed(1)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-primary-500" style={{ width: `${monthlyPercentage}%` }} /></div>
            <p className="mt-2 text-xs text-fg3">New AI calls stop after recorded calendar-month cost reaches {money(overview.usageSettings.monthlyAiBudgetUsd)}.</p>
          </div>
        </div>
        <div className="mb-4 rounded-lg border border-line bg-surface-tint p-4 text-sm text-fg2">
          <p><span className="font-semibold text-fg1">Company hard stops:</span> global estimated model spend across every student. Student credit value and monthly plan allowances below control how quickly each student consumes their share.</p>
          <p className="mt-1">Operations alerts open at {overview.usageSettings.budgetWarningThresholds.map((threshold) => `${Math.round(threshold * 100)}%`).join(', ')}. A call that crosses 100% finishes; later calls are blocked until the UTC day or month rolls over, or you raise the limit.</p>
        </div>
        <UsageEconomicsControls settings={overview.usageSettings} />
      </section>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 className="mb-3 text-xl font-bold text-fg1">Operational alerts</h2>
        <p className="mb-3 text-sm text-fg3">Runtime failures and cost thresholds are stored here; routine operational alerts do not send email.</p>
        {openAlerts.length === 0 ? (
          <p className="text-sm text-fg3">No open alerts.</p>
        ) : (
          <div className="divide-y divide-line">
            {openAlerts.map((alert) => (
              <div key={alert.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div><p className="font-semibold text-fg1">{alert.title}</p><p className="text-sm text-fg3">{alert.message}</p></div>
                <ResolveAlertButton alertId={alert.id} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-col gap-3 border-b border-line p-5 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="text-xl font-bold text-fg1">Student directory</h2><p className="text-sm text-fg3">Chat access, exports, and deletions are audit logged.</p></div>
          <form className="flex items-center gap-2">
            <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-fg3" /><input name="q" defaultValue={query} placeholder="Search students" className="rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-fg1" /></div>
            <button className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-fg1 hover:bg-surface-tint">Search</button>
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-surface-tint text-fg3"><tr><th className="px-5 py-3">Student</th><th className="px-5 py-3">Plan</th><th className="px-5 py-3">Canvas</th><th className="px-5 py-3">Google</th><th className="px-5 py-3">Joined</th></tr></thead>
            <tbody className="divide-y divide-line">
              {directory.students.map((student) => (
                <tr key={student.id} className="hover:bg-surface-tint/50">
                  <td className="px-5 py-3"><Link href={`/dashboard/admin/students/${student.studentKey}`} className="font-semibold text-primary-600 hover:underline">{student.name || student.email}</Link><p className="text-xs text-fg3">{student.email}</p></td>
                  <td className="px-5 py-3 text-fg2">{student.plan}</td>
                  <td className="px-5 py-3 text-fg2">{student.canvasStatus || 'not connected'}</td>
                  <td className="px-5 py-3 text-fg2">{student.googleStatus || 'not connected'}</td>
                  <td className="px-5 py-3 text-fg3">{new Date(student.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
          <p className="text-fg3">{directory.total} student{directory.total === 1 ? '' : 's'}</p>
          <div className="flex gap-2">
            {page > 1 && <Link href={`/dashboard/admin?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(page - 1) })}`} className="rounded-lg border border-line px-3 py-1.5 text-fg2 hover:bg-surface-tint">Previous</Link>}
            {directory.offset + directory.students.length < directory.total && <Link href={`/dashboard/admin?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(page + 1) })}`} className="rounded-lg border border-line px-3 py-1.5 text-fg2 hover:bg-surface-tint">Next</Link>}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 className="mb-3 text-xl font-bold text-fg1">Recent admin audit</h2>
        {overview.recentAuditLogs.length === 0 ? (
          <p className="text-sm text-fg3">No admin actions yet.</p>
        ) : (
          <div className="divide-y divide-line">
            {overview.recentAuditLogs.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <p className="font-medium text-fg1">{entry.action.replaceAll('.', ' ')}</p>
                <p className="text-fg3">{entry.metadata.targetStudentKey || entry.metadata.targetFingerprint || 'global'} · {new Date(entry.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
