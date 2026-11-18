'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useSession } from '@/components/SessionProvider';

export default function CheckoutPage() {
  const { status, data } = useSession();
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (status === 'loading' || started.current) return;
    const params = new URLSearchParams(window.location.search);
    const interval = params.get('interval');
    const trial = params.get('trial') === '1';
    if (interval !== 'monthly' && interval !== 'yearly') { window.location.replace('/dashboard/billing'); return; }
    if (status === 'unauthenticated') { window.location.replace(`/auth/signin?interval=${interval}${trial ? '&trial=1' : ''}`); return; }
    if (data?.user.plan !== 'free') { window.location.replace('/dashboard/billing'); return; }
    started.current = true;
    void fetch('/api/worker/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'stupro', interval, trial }) }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.message || 'Checkout could not open. Your Free account is ready to use.');
      window.location.assign(result.url);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Checkout could not open.'));
  }, [status, data]);
  return <div className="flex min-h-[100dvh] items-center justify-center bg-paper p-6 text-center"><div>
    {!error && <Loader2 className="mx-auto mb-4 h-5 w-5 animate-spin text-primary-600" />}
    <h1 className="text-2xl font-semibold text-fg1">{error ? 'Your account is ready' : 'Opening secure checkout…'}</h1>
    <p className="mt-3 text-fg3">{error || 'Your StuPro subscription will be linked to this account.'}</p>
    <a href="/dashboard/billing" className="mt-6 inline-block text-primary-600 underline">{error ? 'Continue to billing' : 'Continue with Free instead'}</a>
  </div></div>;
}
