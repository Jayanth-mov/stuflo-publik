'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const ACTIVITY_INTERVAL_MS = 15 * 60 * 1000;

export default function PublikActivity() {
  const pathname = usePathname();

  useEffect(() => {
    if (navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes') return;
    const active = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch('/api/worker/publik/activity', { method: 'POST', cache: 'no-store' }).catch(() => {});
    };
    active();
    document.addEventListener('visibilitychange', active);
    const timer = window.setInterval(active, ACTIVITY_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', active);
      window.clearInterval(timer);
    };
  }, [pathname]);

  return null;
}
