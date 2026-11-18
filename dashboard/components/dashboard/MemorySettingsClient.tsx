'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brain, Loader2, Plus, Trash2 } from 'lucide-react';

type Profile = {
  preferredName: string | null;
  communicationStyle: string;
  responseVerbosity: string;
  learningGoals: string[];
  studyPreferences: Record<string, string | number | boolean | string[]>;
};

type Memory = {
  id: string;
  category: string;
  content: string;
  source: string;
  pinned: boolean;
  updatedAt: string;
};

export default function MemorySettingsClient({
  initialProfile,
  initialMemories,
}: {
  initialProfile: Profile;
  initialMemories: Memory[];
}) {
  const router = useRouter();
  const [profile, setProfile] = useState(initialProfile);
  const [goals, setGoals] = useState(initialProfile.learningGoals.join('\n'));
  const [memories, setMemories] = useState(initialMemories);
  const [newMemory, setNewMemory] = useState('');
  const [category, setCategory] = useState('preference');
  const [saving, setSaving] = useState(false);
  const actionPending = useRef(false);
  const [message, setMessage] = useState('');

  async function saveProfile() {
    if (actionPending.current) return;
    actionPending.current = true;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch('/api/worker/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...profile,
          learningGoals: goals.split('\n').map((goal) => goal.trim()).filter(Boolean),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { profile?: Profile; message?: string };
      if (response.ok && payload.profile) {
        setProfile(payload.profile);
        setGoals(payload.profile.learningGoals.join('\n'));
        setMessage('Preferences saved.');
        router.refresh();
      } else setMessage(payload.message || 'Could not save preferences.');
    } catch { setMessage('Could not save preferences. Check your connection and try again.'); }
    finally { actionPending.current = false; setSaving(false); }
  }

  async function createMemory() {
    if (!newMemory.trim() || actionPending.current) return;
    actionPending.current = true;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch('/api/worker/memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, content: newMemory.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as { memory?: Memory; message?: string };
      if (response.ok && payload.memory) {
        setMemories((current) => [payload.memory!, ...current.filter((memory) => memory.id !== payload.memory!.id)]);
        setNewMemory('');
        setMessage('Memory added.');
      } else {
        setMessage(payload.message || 'Could not add memory.');
      }
    } catch { setMessage('Could not add memory. Check your connection and try again.'); }
    finally { actionPending.current = false; setSaving(false); }
  }

  async function deleteMemory(id: string) {
    if (actionPending.current) return;
    actionPending.current = true;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`/api/worker/memories/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        setMemories((current) => current.filter((memory) => memory.id !== id));
        setMessage('Memory forgotten.');
      } else {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        setMessage(payload.message || 'Could not forget memory. Try again.');
      }
    } catch { setMessage('Could not forget memory. Check your connection and try again.'); }
    finally { actionPending.current = false; setSaving(false); }
  }

  const inputClass =
    'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-base text-fg1 outline-none focus:border-transparent focus:ring-2 focus:ring-primary-500';

  return (
    <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <Brain className="h-5 w-5 text-primary-500" strokeWidth={1.85} />
        <div>
          <h2 className="text-xl font-bold text-fg1">Stu preferences and long-term memory</h2>
          <p className="text-sm text-fg3">Cloud-synced context that follows your account across devices.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-fg2">
          Preferred name
          <input
            className={`${inputClass} mt-1`}
            value={profile.preferredName || ''}
            maxLength={120}
            onChange={(event) => setProfile({ ...profile, preferredName: event.target.value })}
          />
        </label>
        <label className="text-sm font-medium text-fg2">
          Communication style
          <select
            className={`${inputClass} mt-1`}
            value={profile.communicationStyle}
            onChange={(event) => setProfile({ ...profile, communicationStyle: event.target.value })}
          >
            <option value="concise">Concise</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label className="text-sm font-medium text-fg2">
          Response detail
          <select
            className={`${inputClass} mt-1`}
            value={profile.responseVerbosity}
            onChange={(event) => setProfile({ ...profile, responseVerbosity: event.target.value })}
          >
            <option value="concise">Concise</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label className="text-sm font-medium text-fg2">
          Best study time
          <input
            className={`${inputClass} mt-1`}
            placeholder="e.g. weekday evenings"
            value={String(profile.studyPreferences.bestStudyTime || '')}
            onChange={(event) =>
              setProfile({
                ...profile,
                studyPreferences: { ...profile.studyPreferences, bestStudyTime: event.target.value },
              })
            }
          />
        </label>
      </div>
      <label className="mt-4 block text-sm font-medium text-fg2">
        Learning goals (one per line)
        <textarea className={`${inputClass} mt-1 min-h-24`} value={goals} onChange={(event) => setGoals(event.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => void saveProfile()}
        disabled={saving}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2.5 text-base font-medium text-white hover:bg-primary-600 disabled:opacity-50"
      >
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Save preferences
      </button>

      <div className="my-6 border-t border-line" />
      <h3 className="font-semibold text-fg1">Things Stu remembers</h3>
      <p className="mb-3 text-sm text-fg3">You can add or remove anything. Stu may also save explicit “remember this” requests.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select className={`${inputClass} sm:w-40`} value={category} onChange={(event) => setCategory(event.target.value)}>
          {['preference', 'goal', 'course', 'schedule', 'accessibility', 'personal', 'other'].map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <input className={inputClass} maxLength={1000} value={newMemory} onChange={(event) => setNewMemory(event.target.value)} placeholder="Remember that..." />
        <button type="button" onClick={() => void createMemory()} disabled={saving || !newMemory.trim()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-line px-4 py-2.5 font-medium text-fg1 hover:bg-surface-tint disabled:opacity-50">
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>
      <div className="mt-4 divide-y divide-line">
        {memories.length === 0 ? (
          <p className="py-4 text-sm text-fg3">Nothing saved yet.</p>
        ) : memories.map((memory) => (
          <div key={memory.id} className="flex items-start justify-between gap-4 py-3">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-primary-600">{memory.category}</span>
              <p className="text-base text-fg1">{memory.content}</p>
              <p className="text-xs text-fg3">Saved by {memory.source}</p>
            </div>
            <button type="button" disabled={saving} onClick={() => void deleteMemory(memory.id)} aria-label="Forget memory" className="rounded-lg p-2 text-fg3 hover:bg-surface-tint hover:text-danger-600 disabled:opacity-50">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      {message && <p role="status" className="mt-3 text-sm text-fg2">{message}</p>}
    </section>
  );
}
