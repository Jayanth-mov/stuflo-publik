'use client';

import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { parsePublikStatus, type PublikStatus } from '@/lib/publik';

const POLL_INTERVAL_MS = 3_000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const primary = 'inline-flex items-center justify-center rounded-xl bg-primary-500 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-600 disabled:opacity-50';
const secondary = 'inline-flex items-center justify-center rounded-xl border border-line bg-surface px-4 py-3 text-sm font-semibold text-fg1 hover:bg-surface-tint disabled:opacity-50';

export default function PublikGate({ initialStatus, settings }: {
  initialStatus: PublikStatus;
  settings: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [pollUntil, setPollUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showOwnKey, setShowOwnKey] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function handleStatus(next: PublikStatus) {
    if (next.state === 'disabled' || (!settings && next.state === 'ready')) {
      window.location.replace('/dashboard');
      return;
    }
    setStatus(next);
  }

  useEffect(() => {
    if (status.state !== 'sign_in' || !pollUntil) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      if (Date.now() >= pollUntil) {
        setPollUntil(0);
        setNotice('Sign-in did not finish. Select Sign in with Publik to try again.');
        return;
      }
      try {
        const res = await fetch('/api/worker/publik/status', { cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted) return;
        if (res.status === 401) { window.location.replace('/auth/signin'); return; }
        if (res.ok) {
          const next = parsePublikStatus(await res.json());
          if (controller.signal.aborted) return;
          if (next.state !== 'sign_in' && next.state !== 'unreachable') {
            if (next.state === 'disabled' || (!settings && next.state === 'ready')) {
              window.location.replace('/dashboard');
              return;
            }
            setNotice('');
            setStatus(next);
            return;
          }
        }
      } catch {
        // Let a temporary issue recover during this pending sign-in.
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [pollUntil, settings, status.state]);

  function beginClaim(event: MouseEvent<HTMLAnchorElement>) {
    const claim = new URL(event.currentTarget.href);
    claim.searchParams.set('return_to', new URL('/publik', window.location.origin).href);
    event.currentTarget.href = claim.toString();
    setPollUntil(Date.now() + POLL_LIMIT_MS);
    setNotice('Complete sign-in in the Publik tab. This page will continue automatically.');
  }

  async function updatePreferences(options: { provider?: 'publik' | 'own' | 'stuflo'; ownKey?: string; usage?: boolean }) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await fetch('/api/worker/publik/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      });
      if (res.status === 401) { window.location.replace('/auth/signin'); return; }
      if (!res.ok) {
        setError(options.ownKey
          ? 'We couldn’t save that OpenAI key. Check the key and try again.'
          : 'We couldn’t save your selection. Try again.');
        return;
      }
      const next = parsePublikStatus(await res.json());
      handleStatus(next);
      if (next.state === 'ready' || next.state === 'choose') {
        setShowOwnKey(false);
        setNotice('Preferences saved.');
      }
    } catch {
      setError('We couldn’t reach StuFlo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function submitOwnKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('openai-key');
    if (typeof value !== 'string' || !value.trim()) return;
    form.reset();
    void updatePreferences({ provider: 'own', ownKey: value.trim() });
  }

  const title = status.state === 'ready' && settings ? 'Publik settings'
    : status.state === 'choose' ? 'Choose how to pay for AI' : 'Sign in with Publik';

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-paper px-4 py-8">
      <div className="w-full max-w-md space-y-5 rounded-2xl border border-line bg-surface p-7 shadow-sm sm:p-10">
        <div className="space-y-2">
          <p className="text-sm font-semibold text-primary-600">StuFlo</p>
          <h1 className="text-3xl font-bold text-fg1">{title}</h1>
        </div>
        {status.state === 'sign_in' && status.claimUrl && <>
          <p className="text-fg3">Connect your Publik account to continue. This keeps your existing StuFlo account and saved work in place.</p>
          <a href={status.claimUrl} onClick={beginClaim} target="_blank" rel="noreferrer" className={primary}>
            Sign in with Publik
          </a>
        </>}
        {status.state === 'unreachable' && <>
          <p className="text-fg3">Publik is not reachable. Check your connection.</p>
          <button type="button" className={primary} onClick={() => window.location.reload()}>Retry</button>
        </>}
        {(status.state === 'choose' || status.state === 'ready') && <>
          <p className="text-fg3">
            {status.state === 'ready'
              ? `Current AI funding: ${status.provider === 'own' ? 'your OpenAI key' : status.provider === 'stuflo' ? 'StuPro credits' : 'Publik'}.`
              : 'Use your Publik plan or an OpenAI key you already have.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {status.hasPlan ? (
              <button type="button" className={primary} disabled={busy || status.provider === 'publik' && status.state === 'ready'}
                onClick={() => void updatePreferences({ provider: 'publik' })}>Connect your plan</button>
            ) : status.topUpUrl ? (
              <a href={status.topUpUrl} target="_blank" rel="noreferrer" className={primary}>Get a plan</a>
            ) : null}
            <button type="button" className={secondary} disabled={busy} aria-expanded={showOwnKey}
              onClick={() => setShowOwnKey(!showOwnKey)}>
              {status.provider === 'own' ? 'Replace my OpenAI key' : 'Use my own key'}
            </button>
            {status.stuPro && <button type="button" className={secondary} disabled={busy || status.provider === 'stuflo'}
              onClick={() => void updatePreferences({ provider: 'stuflo' })}>Use my StuPro credits</button>}
            {!status.hasPlan && (
              <button type="button" disabled={busy} className={secondary} onClick={() => window.location.reload()}>Check plan status</button>
            )}
          </div>
          {showOwnKey && (
            <form method="post" autoComplete="off" onSubmit={submitOwnKey} className="space-y-2">
              <label htmlFor="openai-key" className="block text-sm font-semibold text-fg1">OpenAI API key</label>
              <input id="openai-key" name="openai-key" type="password" autoComplete="off" spellCheck={false}
                required minLength={16} maxLength={512} disabled={busy}
                className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-fg1 focus:outline-none focus:ring-2 focus:ring-primary-500" />
              <button type="submit" className={secondary} disabled={busy}>Save key</button>
            </form>
          )}
          <div className="space-y-1 border-t border-line pt-4">
            <label className="flex items-start gap-3 text-sm font-semibold text-fg1">
              <input type="checkbox" checked={status.usage} disabled={busy}
                onChange={(event) => void updatePreferences({ usage: event.currentTarget.checked })}
                className="mt-0.5 h-4 w-4 accent-primary-500" />
              Share app activity with Publik
            </label>
            <p className="text-xs leading-relaxed text-fg3">
              This sends that you opened or used the app. It does not include chats, documents, or coursework.
              If you select Publik for AI, it processes the context needed to answer your requests.
              {status.aiProviders.length > 0 && ` Its current providers include ${status.aiProviders.join(', ')}.`}
              {' '}<a href="https://publikhq.com/privacy" className="underline" target="_blank" rel="noreferrer">Publik privacy policy</a>
            </p>
          </div>
          {status.provider === 'publik' && status.remainingPercent !== null &&
            <p className="text-sm text-fg3">Publik usage: {status.remainingPercent}% left</p>}
        </>}
        {notice && <p className="text-sm text-fg3" role="status">{notice}</p>}
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
        {settings && status.state === 'ready' && <a href="/dashboard/settings" className="text-sm font-medium text-primary-600 underline">Back to settings</a>}
      </div>
    </main>
  );
}
