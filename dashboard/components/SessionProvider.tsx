'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

export type StuFloSession = {
  user: {
    email: string;
    name: string | null;
    studentKey: string;
    timeZone: string;
    plan: string;
    isAdmin: boolean;
  };
  expiresAt: string;
};

type SessionContextValue = {
  data: StuFloSession | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  update: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

async function fetchSession(): Promise<StuFloSession | null> {
  const response = await fetch('/api/worker/auth/session', { cache: 'no-store' });
  if (!response.ok) return null;
  return (await response.json()) as StuFloSession;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider.');
  return value;
}

export default function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [data, setData] = useState<StuFloSession | null>(null);
  const [status, setStatus] = useState<SessionContextValue['status']>('loading');

  const update = useCallback(async () => {
    try {
      const session = await fetchSession();
      setData(session);
      setStatus(session ? 'authenticated' : 'unauthenticated');
    } catch {
      setData(null);
      setStatus('unauthenticated');
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/worker/auth/logout', { method: 'POST' }).catch(() => undefined);
    setData(null);
    setStatus('unauthenticated');
    router.replace('/');
    router.refresh();
  }, [router]);

  useEffect(() => {
    let active = true;
    void fetchSession()
      .then((session) => {
        if (!active) return;
        setData(session);
        setStatus(session ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        if (!active) return;
        setData(null);
        setStatus('unauthenticated');
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(() => ({ data, status, update, signOut }), [data, signOut, status, update]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
