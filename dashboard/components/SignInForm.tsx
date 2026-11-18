'use client';

import { useSession } from '@/components/SessionProvider';
import { useEffect, useState } from 'react';
import { Loader2, ArrowLeft, Mail } from 'lucide-react';

export default function SignInForm({ interval, google, trial = false }: { interval: string; google: string; trial?: boolean }) {
  const { status } = useSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [googleUrl, setGoogleUrl] = useState('');
  const destination = interval === 'monthly' || interval === 'yearly' ? `/auth/checkout?interval=${interval}${trial ? '&trial=1' : ''}` : '/dashboard';
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (status === 'authenticated') { window.location.replace(destination); return; }
    void fetch('/api/worker/auth/options', { cache: 'no-store' }).then((r) => r.json()).then((options) => {
      if (google === 'error') setError('Google sign-in could not finish. Try again or use an email code.');
      if (google === 'cancelled') setNotice('Google sign-in was cancelled. You can try again or use email.');
      if (options.googleStartUrl) {
        const url = new URL(options.googleStartUrl);
        if (interval === 'monthly' || interval === 'yearly') url.searchParams.set('interval', interval);
        if (trial && (interval === 'monthly' || interval === 'yearly')) url.searchParams.set('trial', '1');
        setGoogleUrl(url.toString());
      }
      if (google === 'verify_email' && options.pendingEmail) {
        setEmail(options.pendingEmail);
        setNotice('One more step: verify this email with a code to connect your Google sign-in.');
      }
    }).catch(() => setError('Sign-in options could not load. Refresh the page or continue with email.'));
  }, [status, destination, interval, google, trial]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function requestCode() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/worker/auth/email/request', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Unable to send your code. Try again.');
      setChallengeId(result.challengeId); setCode(''); setCooldown(60);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to send your code.'); }
    finally { setLoading(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!challengeId) { await requestCode(); return; }
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/worker/auth/email/verify', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code, challengeId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Unable to verify your code.');
      window.location.assign(destination);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to verify your code.'); setLoading(false); }
  }

  if (status !== 'unauthenticated') return <div className="flex min-h-[100dvh] items-center justify-center bg-paper"><Loader2 className="h-5 w-5 animate-spin text-primary-600" aria-label="Loading" /></div>;
  const inputClass = 'w-full rounded-xl border border-line bg-surface px-4 py-3 text-fg1 placeholder:text-fg3 focus:outline-none focus:ring-2 focus:ring-primary-500';
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-paper px-4 py-8">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-7 text-center shadow-sm sm:p-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/stuflo-logo.svg" alt="StuFlo" className="mx-auto mb-7 h-9 w-auto" />
        <h1 className="mb-2 text-3xl font-bold text-fg1">{challengeId ? 'Check your email' : 'Welcome to StuFlo'}</h1>
        <p className="mb-7 text-base text-fg3">{challengeId ? `Enter the six-digit code sent to ${email.trim()}. It expires in 10 minutes.` : 'Sign in or create your free account.'}</p>
        {notice && <p className="mb-5 rounded-xl bg-primary-50 p-3 text-sm text-fg2" role="status">{notice}</p>}
        {error && <p className="mb-5 rounded-xl border border-danger-600 bg-danger-100 p-3 text-sm text-danger-600" role="alert">{error}</p>}
        {!challengeId && <>
          <a href={googleUrl || undefined} aria-disabled={!googleUrl} className={`flex w-full items-center justify-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 font-semibold text-fg1 transition-colors hover:bg-paper ${!googleUrl ? 'pointer-events-none opacity-50' : ''}`}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48"><path fill="#4285F4" d="M43.6 20.5H24v8h11.3c-.5 2.6-2 4.8-4.2 6.2v5.2h6.8c4-3.7 6.2-9.1 6.2-15.5 0-1.3-.1-2.6-.5-3.9Z"/><path fill="#34A853" d="M24 44c5.6 0 10.3-1.9 13.8-5.1L31 33.7c-1.9 1.3-4.2 2-7 2-5.4 0-10-3.7-11.6-8.7H5.4v5.4A20.8 20.8 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.4 27a12.5 12.5 0 0 1 0-8V13.6h-7A20 20 0 0 0 3 23c0 3.4.9 6.6 2.4 9.4l7-5.4Z"/><path fill="#EA4335" d="M24 10.3c3 0 5.7 1 7.8 3l5.9-5.9A20 20 0 0 0 24 2 20.8 20.8 0 0 0 5.4 13.6l7 5.4c1.6-5 6.2-8.7 11.6-8.7Z"/></svg>
            Continue with Google
          </a>
          <div className="my-6 flex items-center gap-3 text-sm text-fg3"><span className="h-px flex-1 bg-line" />or continue with email<span className="h-px flex-1 bg-line" /></div>
        </>}
        <form onSubmit={submit} className="space-y-4">
          {challengeId ? <>
            <label htmlFor="code" className="sr-only">Six-digit sign-in code</label>
            <input id="code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className={`${inputClass} text-center text-3xl tracking-[0.35em]`} placeholder="000000" />
          </> : <>
            <label htmlFor="email" className="sr-only">Email address</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@university.edu" required className={inputClass} />
          </>}
          <button disabled={loading || (challengeId ? code.length !== 6 : !email.trim())} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary-500 px-4 py-3 font-semibold text-white hover:bg-primary-600 disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {loading ? 'Please wait…' : challengeId ? 'Verify and continue' : 'Send sign-in code'}
          </button>
        </form>
        {challengeId ? <div className="mt-5 flex items-center justify-between text-sm">
          <button type="button" disabled={loading} onClick={() => { setChallengeId(''); setCode(''); setError(''); }} className="flex items-center gap-1 text-fg3"><ArrowLeft className="h-3 w-3" />Change email</button>
          <button type="button" disabled={loading || cooldown > 0} onClick={() => void requestCode()} className="text-primary-600 disabled:text-fg3">{cooldown ? `Resend in ${cooldown}s` : 'Resend code'}</button>
        </div> : <p className="mt-6 text-sm text-fg3">New here? Your account starts on Free. No card required.</p>}
        <p className="mt-6 text-xs leading-relaxed text-fg3">By continuing, you agree to our <a href="https://stuflo.com/tos" className="underline">Terms</a> and acknowledge our <a href="https://stuflo.com/privacy-policy" className="underline">Privacy Policy</a>.</p>
      </div>
    </div>
  );
}
