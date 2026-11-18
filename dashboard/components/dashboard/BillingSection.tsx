import { workerApiJson } from '@/lib/worker-api';
import { CheckCircle, Crown, ExternalLink, FileText, Zap } from 'lucide-react';
import { StripePortalButton } from '@/app/dashboard/billing/stripe-portal-button';
import { SwitchPlanButton } from '@/app/dashboard/billing/switch-plan-button';

type PlanKey = 'free' | 'stuflo' | 'stupro';
type BillingSummary = {
  plan: PlanKey;
  hasStripeCustomer: boolean;
  subscriptions: Array<{
    stripeSubscriptionId: string;
    status: string;
    plan: PlanKey;
    interval: 'monthly' | 'yearly';
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>;
  invoices: Array<{
    id: string;
    created: number | null;
    total: number;
    currency: string;
    status: string | null;
    hostedInvoiceUrl: string | null;
    invoicePdf: string | null;
  }>;
};

const STUPRO_PERKS = [
  'Everything in free StuFlo',
  '250 credits every month',
  'Credits reset monthly with no rollover',
];

function formatDate(value: string | number | null) {
  if (!value) return 'Unknown';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatAmount(total: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(total / 100);
}

export default async function BillingSection() {
  const summary = await workerApiJson<BillingSummary>('/v1/billing/summary');
  const currentPlan: PlanKey = summary?.plan === 'stupro' ? 'stupro' : 'free';
  const subscription = summary?.subscriptions[0] || null;
  const interval = subscription?.interval === 'yearly' ? 'Yearly' : 'Monthly';
  const PlanIcon = currentPlan === 'stupro' ? Crown : Zap;
  const status = currentPlan === 'free'
    ? 'Active'
    : subscription?.cancelAtPeriodEnd
      ? 'Canceling'
      : subscription?.status === 'trialing'
        ? 'Active trial'
        : subscription?.status === 'active' || subscription?.status === 'past_due'
          ? 'Active'
          : subscription?.status || 'Pending';
  const renewalCopy = currentPlan === 'free'
    ? 'Includes 25 credits each month. Unused credits do not roll over.'
    : subscription?.currentPeriodEnd
      ? `${subscription.cancelAtPeriodEnd ? 'Access ends' : 'Renews'} ${formatDate(subscription.currentPeriodEnd)}.`
      : 'Stripe will show the next billing date after synchronization.';

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-2 border-primary-500 bg-surface p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${currentPlan === 'stupro' ? 'bg-primary-500 text-white' : 'bg-primary-100 text-primary-600'}`}>
              <PlanIcon className="h-6 w-6" strokeWidth={1.85} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xl font-bold text-fg1">{currentPlan === 'stupro' ? 'StuPro Subscription' : 'StuFlo Free'}</h3>
                <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-medium text-success-600">{status}</span>
              </div>
              <p className="mt-1 text-base font-medium text-fg2">{interval}</p>
              <p className="mt-2 text-base text-fg3">{renewalCopy}</p>
            </div>
          </div>
          {(currentPlan === 'stupro' || summary?.hasStripeCustomer) && (
            <StripePortalButton hasCustomer={Boolean(summary?.hasStripeCustomer)} />
          )}
        </div>
      </div>

      {currentPlan === 'free' && (
        <div className="rounded-2xl border-2 border-primary-300 bg-surface p-5 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <span className="rounded-full bg-primary-500 px-2.5 py-1 text-xs font-semibold text-white">StuPro</span>
              <h3 className="mt-3 text-xl font-bold text-fg1">StuPro Subscription</h3>
              <p className="mt-1 text-base font-semibold text-fg1">$9/month or $84/year</p>
              <ul className="mt-4 space-y-2">
                {STUPRO_PERKS.map((perk) => (
                  <li key={perk} className="flex items-center gap-2 text-base text-fg2">
                    <CheckCircle className="h-4 w-4 shrink-0 text-primary-500" strokeWidth={1.85} />
                    {perk}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto">
              <SwitchPlanButton plan="stupro" interval="month" label="Choose monthly · $9" />
              <SwitchPlanButton plan="stupro" interval="year" label="Choose yearly · $84" />
            </div>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary-500" strokeWidth={1.85} />
          <h3 className="text-xl font-bold text-fg1">Billing history</h3>
        </div>
        {!summary?.hasStripeCustomer ? (
          <p className="text-base text-fg3">No Stripe billing history yet.</p>
        ) : !summary.invoices.length ? (
          <p className="text-base text-fg3">No invoices found for this account yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead><tr className="border-b border-line text-sm font-semibold text-fg3"><th className="py-2 pr-4">Date</th><th className="py-2 pr-4">Price</th><th className="py-2 pr-4">Status</th><th className="py-2 text-right">Invoice</th></tr></thead>
              <tbody className="divide-y divide-line">
                {summary.invoices.map((invoice) => {
                  const viewUrl = invoice.hostedInvoiceUrl || invoice.invoicePdf;
                  return (
                    <tr key={invoice.id} className="text-base text-fg2">
                      <td className="py-3 pr-4 text-fg1">{formatDate(invoice.created)}</td>
                      <td className="py-3 pr-4">{formatAmount(invoice.total, invoice.currency)}</td>
                      <td className="py-3 pr-4 capitalize">{invoice.status || 'Unknown'}</td>
                      <td className="py-3 text-right">{viewUrl ? <a href={viewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-primary-600">View <ExternalLink className="h-3.5 w-3.5" /></a> : <span className="text-fg3">Unavailable</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
