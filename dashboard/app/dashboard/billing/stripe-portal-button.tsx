'use client';

import { useState } from 'react';
import { ExternalLink, Loader2, CreditCard } from 'lucide-react';

export function StripePortalButton({ hasCustomer }: { hasCustomer: boolean }) {
  const [loading, setLoading] = useState(false);

  async function openPortal() {
    setLoading(true);
    try {
      const res = await fetch('/api/worker/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        alert(data.error);
      }
    } catch {
      alert('Error opening billing portal');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={openPortal}
      disabled={loading}
      className="flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-base font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 sm:w-auto"
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.85} />
      ) : (
        <CreditCard className="w-4 h-4" strokeWidth={1.85} />
      )}
      {loading ? 'Loading…' : hasCustomer ? 'Manage billing in Stripe' : 'Set up billing'}
      <ExternalLink className="w-3.5 h-3.5 opacity-70" strokeWidth={1.85} />
    </button>
  );
}
