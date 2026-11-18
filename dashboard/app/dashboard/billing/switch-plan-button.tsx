'use client';

import { useState } from 'react';

export function SwitchPlanButton({
  plan,
  interval = 'month',
  label,
}: {
  plan: 'stuflo' | 'stupro';
  interval?: 'month' | 'year';
  label?: string;
}) {
  const [loading, setLoading] = useState(false);

  const buttonLabel = label || (plan === 'stupro' ? 'Upgrade to StuPro' : 'Switch to StuFlo');

  const handleClick = async () => {
    setLoading(true);

    if (plan === 'stupro') {
      const res = await fetch('/api/worker/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, interval: interval === 'year' ? 'yearly' : 'monthly' }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error || 'Unable to start checkout');
        setLoading(false);
      }
      return;
    }

    const res = await fetch('/api/worker/billing/portal', { method: 'POST' });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert(data.error || 'Unable to open billing portal');
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="w-full bg-primary-500 text-white px-5 py-2.5 rounded-lg text-base font-medium hover:bg-primary-600 transition-colors disabled:opacity-50 sm:w-auto sm:whitespace-nowrap"
    >
      {loading ? 'Loading...' : buttonLabel}
    </button>
  );
}
