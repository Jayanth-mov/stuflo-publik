'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/SessionProvider';
import { CreditCard, Loader2 } from 'lucide-react';

type EditableFieldProps = {
  label: string;
  value: string;
  fallback?: string;
  inputType?: 'text' | 'email';
  saving: boolean;
  onSave: (value: string) => Promise<void>;
};

function EditableField({
  label,
  value,
  fallback = 'Not set',
  inputType = 'text',
  saving,
  onSave,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const trimmedDraft = draft.trim();
  const canSave = trimmedDraft.length > 0 && trimmedDraft !== value.trim() && !saving;

  async function handleAction() {
    if (!editing) {
      setDraft(value);
      setEditing(true);
      return;
    }

    if (!canSave) return;
    try {
      await onSave(trimmedDraft);
      setEditing(false);
    } catch {
      // Keep the field open so the user can adjust and retry.
    }
  }

  return (
    <div className="grid gap-2 border-b border-line py-3 last:border-b-0 sm:grid-cols-[9rem_1fr_auto] sm:items-center sm:gap-4">
      <dt className="text-base font-medium text-fg3">{label}</dt>
      <dd className="min-w-0">
        {editing ? (
          <input
            type={inputType}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleAction();
            }}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base font-medium text-fg1 outline-none transition focus:border-transparent focus:ring-2 focus:ring-primary-500"
            autoFocus
          />
        ) : (
          <span className="block break-words text-base font-medium text-fg1">{value || fallback}</span>
        )}
      </dd>
      <button
        type="button"
        onClick={handleAction}
        disabled={editing && !canSave}
        className="inline-flex items-center justify-center rounded-lg border border-line bg-surface px-3 py-2 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint disabled:cursor-not-allowed disabled:opacity-50"
      >
        {editing ? saving ? 'Saving...' : 'Save' : 'Change'}
      </button>
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  fallback = 'Not set',
}: {
  label: string;
  value: string;
  fallback?: string;
}) {
  return (
    <div className="grid gap-2 border-b border-line py-3 last:border-b-0 sm:grid-cols-[9rem_1fr_auto] sm:items-center sm:gap-4">
      <dt className="text-base font-medium text-fg3">{label}</dt>
      <dd className="min-w-0 break-words text-base font-medium text-fg1">{value || fallback}</dd>
      <div className="hidden sm:block" aria-hidden="true" />
    </div>
  );
}

export default function AccountSettingsClient({
  initialName,
  initialEmail,
  plan,
  planLabel,
}: {
  initialName: string;
  initialEmail: string;
  plan: string;
  planLabel: string;
}) {
  const router = useRouter();
  const { update } = useSession();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [savingField, setSavingField] = useState<'name' | 'email' | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function saveAccount(patch: { name?: string; email?: string }) {
    const field = patch.name !== undefined ? 'name' : 'email';
    setSavingField(field);
    setMessage('');
    setError('');

    try {
      const res = await fetch('/api/worker/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Could not update account.');
      }

      const nextName = data.name || '';
      const nextEmail = data.email || email;
      setName(nextName);
      setEmail(nextEmail);
      await update();
      router.refresh();
      setMessage('Account updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update account.');
      throw err;
    } finally {
      setSavingField(null);
    }
  }

  async function upgradeToStuPro() {
    setCheckoutLoading(true);
    setMessage('');
    setError('');

    try {
      const res = await fetch('/api/worker/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'stupro', interval: 'monthly' }),
      });
      const data = await res.json().catch(() => ({}));

      if (data.url) {
        window.location.href = data.url;
        return;
      }

      throw new Error(data.error || 'Unable to start StuPro checkout.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start StuPro checkout.');
      setCheckoutLoading(false);
    }
  }

  return (
    <div>
      {(message || error) && (
        <p
          className={`mb-3 rounded-lg border px-3 py-2 text-base ${
            error
              ? 'border-danger-600 bg-danger-100 text-danger-600'
              : 'border-success-100 bg-success-100 text-success-600'
          }`}
        >
          {error || message}
        </p>
      )}

      <dl>
        <EditableField
          label="Name"
          value={name}
          saving={savingField === 'name'}
          onSave={(value) => saveAccount({ name: value })}
        />
        <ReadOnlyField
          label="Email"
          value={email}
          fallback="Not available"
        />
        <div className="grid gap-2 border-b border-line py-3 last:border-b-0 sm:grid-cols-[9rem_1fr_auto] sm:items-center sm:gap-4">
          <dt className="text-base font-medium text-fg3">Plan</dt>
          <dd className="min-w-0 break-words text-base font-medium text-fg1">{planLabel}</dd>
          {plan !== 'stupro' && (
            <button
              type="button"
              onClick={upgradeToStuPro}
              disabled={checkoutLoading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-3 py-2 text-base font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkoutLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.85} />
              ) : (
                <CreditCard className="h-4 w-4" strokeWidth={1.85} />
              )}
              {checkoutLoading ? 'Loading...' : 'Upgrade · $9/month'}
            </button>
          )}
        </div>
      </dl>
    </div>
  );
}
