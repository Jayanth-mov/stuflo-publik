export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { ArrowLeft, CreditCard, Download, ExternalLink, MessageSquare } from 'lucide-react';
import { AdminDeleteStudent } from '@/components/dashboard/AdminDeleteStudent';
import { workerApiJson } from '@/lib/worker-api';

type Detail = {
  student: {
    studentKey: string;
    email: string;
    name: string | null;
    plan: string;
    status: string;
    timeZone: string;
    canvasStatus: string | null;
    canvasHost: string | null;
    googleStatus: string | null;
    googleEmail: string | null;
  };
  profile: Record<string, unknown> | null;
  memories: Array<{ id: string; category: string; content: string; source: string }>;
  usageEvents: Array<{
    id: string;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedProviderCostUsd: string | number | null;
    metadata?: { durationMs?: number };
    createdAt: string;
  }>;
  stripeCustomerId: string | null;
  subscriptions: Array<{
    stripeSubscriptionId: string;
    status: string;
    priceId: string;
    plan: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>;
  stripe: null | {
    customerId: string;
    deleted?: boolean;
    delinquent?: boolean;
    balance?: number;
    currency?: string;
    dashboardUrl?: string;
    unavailable?: boolean;
    invoices?: Array<{
      id: string | null;
      created: number | null;
      total: number;
      currency: string;
      status: string | null;
      hostedInvoiceUrl: string | null;
    }>;
  };
};

type Chat = { messages: Array<{ role: string; content: string; createdAt: string }> };

function minorMoney(amount: number, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

export default async function AdminStudentPage({
  params,
}: {
  params: Promise<{ studentKey: string }>;
}) {
  const studentKey = (await params).studentKey;
  const [detail, chat] = await Promise.all([
    workerApiJson<Detail>(`/v1/admin/students/${encodeURIComponent(studentKey)}`),
    workerApiJson<Chat>(`/v1/admin/students/${encodeURIComponent(studentKey)}/chat`),
  ]);
  if (!detail || !chat) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center text-fg3">
        Student not found or owner access required.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/dashboard/admin" className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:underline">
            <ArrowLeft className="h-4 w-4" /> Operations
          </Link>
          <h1 className="text-3xl font-bold text-fg1">{detail.student.name || detail.student.email}</h1>
          <p className="text-fg3">{detail.student.email} · {detail.student.studentKey}</p>
        </div>
        <a href={`/api/worker/admin/students/${encodeURIComponent(studentKey)}/export`} className="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2.5 font-medium text-white hover:bg-primary-600">
          <Download className="h-4 w-4" /> Safe JSON export
        </a>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-xl border border-line bg-surface p-5"><p className="text-sm text-fg3">Account</p><p className="mt-1 font-semibold text-fg1">{detail.student.plan} · {detail.student.status}</p><p className="text-sm text-fg3">{detail.student.timeZone}</p></section>
        <section className="rounded-xl border border-line bg-surface p-5"><p className="text-sm text-fg3">Canvas</p><p className="mt-1 font-semibold text-fg1">{detail.student.canvasStatus || 'Not connected'}</p><p className="truncate text-sm text-fg3">{detail.student.canvasHost || '—'}</p></section>
        <section className="rounded-xl border border-line bg-surface p-5"><p className="text-sm text-fg3">Google Calendar</p><p className="mt-1 font-semibold text-fg1">{detail.student.googleStatus || 'Not connected'}</p><p className="truncate text-sm text-fg3">{detail.student.googleEmail || '—'}</p></section>
      </div>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <CreditCard className="mt-1 h-5 w-5 text-primary-500" />
            <div>
              <h2 className="text-xl font-bold text-fg1">Stripe billing</h2>
              <p className="text-sm text-fg3">{detail.stripeCustomerId || 'No Stripe customer linked to this account.'}</p>
            </div>
          </div>
          {detail.stripe?.dashboardUrl && (
            <a href={detail.stripe.dashboardUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-fg1 hover:bg-surface-tint">
              Open in Stripe <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
        {detail.stripe?.unavailable ? (
          <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">Stripe is temporarily unavailable; StuFlo’s synchronized subscription records are shown below.</p>
        ) : detail.stripe ? (
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-surface-tint p-3"><p className="text-xs uppercase text-fg3">Customer</p><p className="font-semibold text-fg1">{detail.stripe.deleted ? 'Deleted' : 'Active record'}</p></div>
            <div className="rounded-lg bg-surface-tint p-3"><p className="text-xs uppercase text-fg3">Payment state</p><p className="font-semibold text-fg1">{detail.stripe.delinquent ? 'Delinquent' : 'Current'}</p></div>
            <div className="rounded-lg bg-surface-tint p-3"><p className="text-xs uppercase text-fg3">Customer balance</p><p className="font-semibold text-fg1">{minorMoney(detail.stripe.balance || 0, detail.stripe.currency)}</p></div>
          </div>
        ) : null}
        {detail.subscriptions.length === 0 ? (
          <p className="text-sm text-fg3">No synchronized subscriptions.</p>
        ) : (
          <div className="divide-y divide-line">
            {detail.subscriptions.map((subscription) => (
              <div key={subscription.stripeSubscriptionId} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div><p className="font-semibold text-fg1">{subscription.plan} · {subscription.status}</p><p className="text-xs text-fg3">{subscription.stripeSubscriptionId}</p></div>
                <p className="text-fg3">{subscription.currentPeriodEnd ? `Renews/ends ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : 'No period end'}{subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}</p>
              </div>
            ))}
          </div>
        )}
        {detail.stripe?.invoices && detail.stripe.invoices.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 font-semibold text-fg1">Recent invoices</h3>
            <div className="space-y-2">
              {detail.stripe.invoices.slice(0, 6).map((invoice) => (
                <div key={invoice.id || `${invoice.created}-${invoice.total}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p className="text-fg2">{invoice.created ? new Date(invoice.created * 1000).toLocaleDateString() : 'Unknown date'} · {invoice.status || 'unknown'}</p>
                  {invoice.hostedInvoiceUrl ? <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="font-medium text-primary-600 hover:underline">{minorMoney(invoice.total, invoice.currency)}</a> : <span className="text-fg1">{minorMoney(invoice.total, invoice.currency)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 className="mb-3 text-xl font-bold text-fg1">Student preference profile</h2>
        {detail.profile ? <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-tint p-4 text-sm text-fg2">{JSON.stringify(detail.profile, null, 2)}</pre> : <p className="text-sm text-fg3">No preference profile yet.</p>}
      </section>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 className="mb-3 text-xl font-bold text-fg1">Durable memory</h2>
        {detail.memories.length === 0 ? <p className="text-sm text-fg3">No saved memories.</p> : <div className="divide-y divide-line">{detail.memories.map((memory) => <div key={memory.id} className="py-3"><span className="text-xs font-semibold uppercase text-primary-600">{memory.category}</span><p className="text-fg1">{memory.content}</p><p className="text-xs text-fg3">Source: {memory.source}</p></div>)}</div>}
      </section>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2"><MessageSquare className="h-5 w-5 text-primary-500" /><div><h2 className="text-xl font-bold text-fg1">Chat inspection</h2><p className="text-sm text-fg3">This view has been recorded in the audit log.</p></div></div>
        {chat.messages.length === 0 ? <p className="text-sm text-fg3">No messages.</p> : <div className="max-h-[42rem] space-y-3 overflow-y-auto pr-2">{chat.messages.map((message, index) => <div key={`${message.createdAt}-${index}`} className={`rounded-xl p-4 ${message.role === 'user' ? 'ml-8 bg-primary-500 text-white' : 'mr-8 bg-surface-tint text-fg1'}`}><p className="mb-1 text-xs font-semibold uppercase opacity-70">{message.role} · {new Date(message.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words text-sm">{message.content}</p></div>)}</div>}
      </section>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 className="mb-3 text-xl font-bold text-fg1">Recent AI usage</h2>
        {detail.usageEvents.length === 0 ? <p className="text-sm text-fg3">No usage events.</p> : <div className="divide-y divide-line">{detail.usageEvents.slice(0, 50).map((event) => <div key={event.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><div><p className="font-medium text-fg1">{event.model || 'AI model'}</p><p className="text-fg3">{new Date(event.createdAt).toLocaleString()}{event.metadata?.durationMs ? ` · ${(event.metadata.durationMs / 1000).toFixed(1)}s` : ''}</p></div><p className="text-fg2">{event.inputTokens || 0} in · {event.outputTokens || 0} out · ${Number(event.estimatedProviderCostUsd || 0).toFixed(5)}</p></div>)}</div>}
      </section>

      <AdminDeleteStudent
        studentKey={studentKey}
        email={detail.student.email}
        hasStripeCustomer={Boolean(detail.stripeCustomerId)}
      />
    </div>
  );
}
