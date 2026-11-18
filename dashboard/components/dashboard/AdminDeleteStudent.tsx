'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';

export function AdminDeleteStudent({
  studentKey,
  email,
  hasStripeCustomer,
}: {
  studentKey: string;
  email: string;
  hasStripeCustomer: boolean;
}) {
  const router = useRouter();
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const matches = confirmationEmail.trim().toLowerCase() === email.trim().toLowerCase();

  async function removeStudent() {
    if (!matches || !acknowledged || deleting) return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch(`/api/worker/admin/students/${encodeURIComponent(studentKey)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmationEmail }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(
          result.error === 'confirmation_mismatch'
            ? 'The confirmation email does not match this student.'
            : 'Student deletion did not complete. Nothing remaining should be deleted manually; retry here.',
        );
        return;
      }
      router.push('/dashboard/admin');
      router.refresh();
    } catch {
      setError('Student deletion did not complete. Check Operations alerts, then retry here.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/30 sm:p-6">
      <div className="flex items-start gap-3">
        <Trash2 className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
        <div>
          <h2 className="text-xl font-bold text-red-900 dark:text-red-100">Delete student permanently</h2>
          <p className="mt-1 text-sm text-red-800 dark:text-red-200">
            This removes the account, sessions, Canvas and Google credentials, preferences, memories,
            usage, attachments, and chat history.
            {hasStripeCustomer
              ? ' The Stripe customer will also be permanently deleted and active subscriptions will be cancelled immediately.'
              : ' No linked Stripe customer was found.'}
          </p>
        </div>
      </div>
      <div className="mt-4 max-w-xl space-y-3">
        <label className="block text-sm font-medium text-red-900 dark:text-red-100">
          Type {email} to confirm
          <input
            type="email"
            autoComplete="off"
            value={confirmationEmail}
            onChange={(event) => setConfirmationEmail(event.target.value)}
            className="mt-1 w-full rounded-lg border border-red-300 bg-white px-3 py-2 text-fg1 dark:border-red-800 dark:bg-surface"
          />
        </label>
        <label className="flex items-start gap-2 text-sm text-red-900 dark:text-red-100">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-1"
          />
          I understand this cannot be undone and Stripe cancellation is immediate.
        </label>
        <button
          type="button"
          onClick={() => void removeStudent()}
          disabled={!matches || !acknowledged || deleting}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {deleting ? 'Deleting everywhere…' : 'Delete from StuFlo and Stripe'}
        </button>
        {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </section>
  );
}
