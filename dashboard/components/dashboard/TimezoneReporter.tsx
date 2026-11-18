'use client';

import { useEffect } from 'react';

const STORAGE_KEY = 'stuflo-timezone-reported';

export default function TimezoneReporter() {
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return;

    const today = new Date().toISOString().slice(0, 10);
    const marker = `${timeZone}:${today}`;

    try {
      if (localStorage.getItem(STORAGE_KEY) === marker) return;
    } catch {
      // Ignore storage failures; the server can still receive the timezone.
    }

    const controller = new AbortController();
    fetch('/api/worker/account/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeZone }),
      signal: controller.signal,
    }).then((res) => {
      if (!res.ok) return;
      try {
        localStorage.setItem(STORAGE_KEY, marker);
      } catch {}
    }).catch(() => {});

    return () => controller.abort();
  }, []);

  return null;
}
