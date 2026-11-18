'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Calendar,
  CheckCircle,
  ExternalLink,
  GraduationCap,
  Loader2,
  RefreshCw,
} from 'lucide-react';

interface Props {
  initialCanvasStatus: string;
  initialCanvasUrl?: string | null;
  initialCanvasUpdatedAt?: string | null;
  initialGoogleStatus: string;
  initialGoogleResult?: string | null;
  initialGoogleReason?: string | null;
}

interface ConnectionsStatusResponse {
  canvas?: {
    connected?: boolean;
    canvasHost?: string | null;
    cookiesUpdatedAt?: string | null;
    verificationStatus?: 'stored' | 'valid' | 'invalid' | 'unavailable' | 'not_connected';
    reconnectRequired?: boolean;
    message?: string;
  };
  googleCalendar?: {
    connected?: boolean;
    googleEmail?: string;
    verificationStatus?: 'stored' | 'valid' | 'invalid' | 'unavailable' | 'not_connected';
    message?: string;
  };
  error?: string;
}

interface CanvasInitializationOverview {
  run: {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
    coursesTotal: number;
    coursesCompleted: number;
    syllabiFound: number;
    syllabiStored: number;
    errorMessage?: string | null;
    completedAt?: string | null;
    updatedAt: string;
  } | null;
  courses: Array<{
    courseId: string;
    courseName: string;
    courseCode?: string | null;
    termName?: string | null;
    courseUrl: string;
    isActive: boolean;
    syllabusStatus: string;
    syllabusSourceUrl?: string | null;
    syllabusAttachmentIds: string[];
    externalSystems: Array<{ name: string; url: string; kind: string; source: string }>;
    initializedAt: string;
  }>;
}

const extensionDownloadUrl =
  'https://chromewebstore.google.com/detail/stuflo-canvas-connector/hifphneimdhacdlmicpgplncnephmlbf';

const googleConnectionErrors: Record<string, string> = {
  authorization: 'Google did not return a reusable Calendar authorization. Please reconnect and approve Calendar access.',
  calendar_account: 'Google did not return a primary calendar for this account.',
  calendar_api: 'Google Calendar rejected the connection. The Calendar API may be disabled or restricted for this Google account.',
  configuration: 'StuFlo’s Google Calendar connection is not configured correctly.',
  google_unavailable: 'Google Calendar could not be reached. Please try connecting again.',
  scopes: 'The required Google Calendar permissions were not granted. Please reconnect and approve both permissions.',
  session: 'Your StuFlo session was not available when Google returned. Please sign in again, then reconnect Calendar.',
  state: 'The Google connection request expired. Please start the connection again.',
  storage: 'StuFlo could not securely save the Google Calendar connection.',
  unknown: 'Google Calendar could not be connected. Please try again.',
};

function formatUpdatedAt(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function StatusBadge({ connected, waiting = false, initialStatus }: {
  connected: boolean;
  waiting?: boolean;
  initialStatus: 'loading' | 'ready' | 'unavailable';
}) {
  if (connected) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-success-100 px-2.5 py-1 text-xs font-medium text-success-600">
        <CheckCircle className="h-3.5 w-3.5" strokeWidth={1.85} /> Connected
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs font-medium text-fg3">
      {initialStatus === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.85} />}
      {initialStatus === 'loading' ? 'Checking' : initialStatus === 'unavailable' ? 'Unable to check' : waiting ? 'Waiting' : 'Not connected'}
    </span>
  );
}

export default function ConnectionsClient({
  initialCanvasStatus,
  initialCanvasUrl,
  initialCanvasUpdatedAt,
  initialGoogleStatus,
  initialGoogleResult,
  initialGoogleReason,
}: Props) {
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false);
  const [googleIssue, setGoogleIssue] = useState('');
  const [googleEmail, setGoogleEmail] = useState('');
  const googleMutationRevision = useRef(0);
  const statusRequestRevision = useRef(0);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [initialStatus, setInitialStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [watchingCanvas, setWatchingCanvas] = useState(initialCanvasStatus !== 'connected');
  const [canvasConnected, setCanvasConnected] = useState(initialCanvasStatus === 'connected');
  const [canvasVerification, setCanvasVerification] = useState<
    'stored' | 'valid' | 'invalid' | 'unavailable' | 'not_connected'
  >(initialCanvasStatus === 'connected' ? 'stored' : 'not_connected');
  const [canvasMeta, setCanvasMeta] = useState({
    canvasUrl: initialCanvasUrl || '',
    cookiesUpdatedAt: initialCanvasUpdatedAt || '',
  });
  const [canvasIssue, setCanvasIssue] = useState('');
  const [canvasInitialization, setCanvasInitialization] = useState<CanvasInitializationOverview | null>(null);
  const [initializingCanvas, setInitializingCanvas] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(initialGoogleStatus === 'connected');
  const [error, setError] = useState(
    initialGoogleResult === 'cancelled'
      ? 'Google Calendar connection was cancelled.'
      : initialGoogleResult === 'error'
        ? googleConnectionErrors[initialGoogleReason || 'unknown'] || googleConnectionErrors.unknown
        : '',
  );
  const [notice, setNotice] = useState(
    initialGoogleResult === 'connected'
      ? 'Google Calendar connected successfully. Stu can now read and manage your calendar.'
      : '',
  );

  const refreshStatuses = useCallback(async (quiet = false) => {
    const requestRevision = ++statusRequestRevision.current;
    const googleRevision = googleMutationRevision.current;
    if (!quiet) setCheckingStatus(true);
    try {
      const response = await fetch(`/api/worker/connections/status${quiet ? '' : '?verify=google'}`, {
        cache: 'no-store', signal: AbortSignal.timeout(12_000),
      });
      const data = (await response.json().catch(() => ({}))) as ConnectionsStatusResponse;
      if (!response.ok) throw new Error(data.error || 'Failed to refresh connection status');
      if (typeof data.canvas?.connected !== 'boolean' || typeof data.googleCalendar?.connected !== 'boolean') {
        throw new Error('Connection status could not be read. Please try again.');
      }
      if (requestRevision !== statusRequestRevision.current) return;

      const nextCanvasConnected = Boolean(data.canvas?.connected);
      setCanvasConnected(nextCanvasConnected);
      setCanvasVerification(data.canvas?.verificationStatus || 'not_connected');
      setCanvasMeta({
        canvasUrl: data.canvas?.canvasHost || '',
        cookiesUpdatedAt: data.canvas?.cookiesUpdatedAt || '',
      });
      setCanvasIssue(data.canvas?.message || '');
      if (googleRevision === googleMutationRevision.current) {
        setGoogleConnected(Boolean(data.googleCalendar?.connected));
        setGoogleIssue(data.googleCalendar?.message || '');
        setGoogleEmail(data.googleCalendar?.googleEmail || '');
      }
      if (nextCanvasConnected) setWatchingCanvas(false);
      if (data.canvas?.reconnectRequired) setWatchingCanvas(false);
      setInitialStatus('ready');
      if (!quiet) setError('');
    } catch (caught) {
      if (requestRevision !== statusRequestRevision.current) return;
      setInitialStatus((previous) => previous === 'loading' ? 'unavailable' : previous);
      if (!quiet) {
        setError(caught instanceof Error ? caught.message : 'Failed to refresh connection status');
      }
    } finally {
      if (!quiet) setCheckingStatus(false);
    }
  }, []);

  const refreshCanvasInitialization = useCallback(async () => {
    try {
      const response = await fetch('/api/worker/canvas/initialization', { cache: 'no-store' });
      if (!response.ok) return;
      setCanvasInitialization((await response.json()) as CanvasInitializationOverview);
    } catch {
      // Connection status remains usable if initialization status is temporarily unavailable.
    }
  }, []);

  useEffect(() => {
    const refreshQuietly = () => {
      void refreshStatuses(true);
      void refreshCanvasInitialization();
    };
    const initialRefresh = window.setTimeout(refreshQuietly, 0);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshQuietly();
    };

    window.addEventListener('focus', refreshQuietly);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearTimeout(initialRefresh);
      window.removeEventListener('focus', refreshQuietly);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshCanvasInitialization, refreshStatuses]);

  useEffect(() => {
    const status = canvasInitialization?.run?.status;
    if (status !== 'queued' && status !== 'running') return;
    const timer = window.setInterval(() => void refreshCanvasInitialization(), 3_000);
    return () => window.clearInterval(timer);
  }, [canvasInitialization?.run?.status, refreshCanvasInitialization]);

  useEffect(() => {
    if (canvasConnected || !watchingCanvas) return;

    let checks = 0;
    const timer = window.setInterval(() => {
      checks += 1;
      void refreshStatuses(true);
      if (checks >= 40) {
        setWatchingCanvas(false);
        window.clearInterval(timer);
      }
    }, 3_000);

    return () => window.clearInterval(timer);
  }, [canvasConnected, refreshStatuses, watchingCanvas]);

  async function connectGoogleCalendar() {
    setConnectingGoogle(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/worker/connections/google/start');
      const data = (await response.json().catch(() => ({}))) as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!response.ok || !data.authorizationUrl) {
        throw new Error(data.error || 'Failed to start Google Calendar connection');
      }
      window.location.assign(data.authorizationUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to connect Google Calendar');
      setConnectingGoogle(false);
    }
  }

  async function disconnectGoogleCalendar() {
    googleMutationRevision.current += 1;
    setDisconnectingGoogle(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/worker/connections/google', { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Failed to disconnect Google Calendar');
      setGoogleConnected(false);
      setGoogleEmail('');
      setGoogleIssue('');
      setNotice('Google Calendar disconnected. StuFlo’s saved Calendar access was removed.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to disconnect Google Calendar');
    } finally {
      googleMutationRevision.current += 1;
      setDisconnectingGoogle(false);
    }
  }

  async function initializeCanvas() {
    setInitializingCanvas(true);
    setCanvasIssue('');
    try {
      const response = await fetch('/api/worker/canvas/initialization', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not start the Canvas course scan.');
      await refreshCanvasInitialization();
    } catch (caught) {
      setCanvasIssue(caught instanceof Error ? caught.message : 'Could not start the Canvas course scan.');
    } finally {
      setInitializingCanvas(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-xl border border-danger-600 bg-danger-100 px-4 py-3 text-base text-danger-600">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-success-600 bg-success-100 px-4 py-3 text-base text-success-600">
          {notice}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600">
              <GraduationCap className="h-6 w-6" strokeWidth={1.85} />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-fg1">Canvas LMS</h3>
              <p className="mt-0.5 text-base text-fg3">
                Access assignments, grades, syllabi, and announcements
              </p>
            </div>
          </div>
          <StatusBadge connected={canvasConnected} waiting={watchingCanvas} initialStatus={initialStatus} />
        </div>

        <div className="mt-4 space-y-4 border-t border-line pt-4">
          <div className="rounded-xl border border-line bg-paper-sunk p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-base font-medium text-fg1">
                  {!canvasConnected && initialStatus !== 'ready'
                    ? initialStatus === 'loading' ? 'Checking Canvas connection' : 'Canvas status could not be checked'
                    : canvasConnected
                    ? canvasVerification === 'unavailable'
                      ? 'Canvas connection is retrying'
                      : 'Canvas is connected'
                    : canvasIssue
                      ? 'Reconnect Canvas'
                      : 'Connect with the StuFlo Chrome extension'}
                </p>
                <p className="mt-1 text-base text-fg3">
                  {!canvasConnected && initialStatus !== 'ready'
                    ? initialStatus === 'loading' ? 'Loading your saved connection.' : 'Use Check status to try again.'
                    : canvasIssue ||
                    (canvasConnected
                      ? `Using ${canvasMeta.canvasUrl || 'your Canvas site'}${
                          canvasMeta.cookiesUpdatedAt
                            ? `, updated ${formatUpdatedAt(canvasMeta.cookiesUpdatedAt)}`
                            : ''
                        }.`
                      : 'Install the extension, sign into Canvas in Chrome, then connect from the extension popup.')}
                </p>
              </div>
              {canvasMeta.canvasUrl && (
                <a
                  href={`https://${canvasMeta.canvasUrl}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint sm:w-auto sm:whitespace-nowrap"
                >
                  Open Canvas <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              href={extensionDownloadUrl}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-4 py-2.5 text-base font-medium text-white transition-colors hover:bg-primary-600 sm:w-auto"
            >
              Get extension <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              onClick={() => void refreshStatuses(false)}
              disabled={checkingStatus || initialStatus === 'loading'}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint disabled:opacity-50 sm:w-auto"
            >
              {checkingStatus ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Check status
            </button>
          </div>

          {canvasConnected && (
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-primary-500" strokeWidth={1.85} />
                  <div>
                    <p className="font-semibold text-fg1">Course initializer</p>
                    <p className="mt-1 text-sm text-fg3">
                      Stu inventories your courses, class structure, external systems, and saves private syllabus copies. It runs after the first connection and checks weekly for semester changes. Refreshing here downloads syllabi again, including copies you deleted.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void initializeCanvas()}
                  disabled={initializingCanvas || ['queued', 'running'].includes(canvasInitialization?.run?.status || '')}
                  className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium text-fg1 hover:bg-surface-tint disabled:opacity-50 sm:w-auto"
                >
                  {initializingCanvas || ['queued', 'running'].includes(canvasInitialization?.run?.status || '') ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {canvasInitialization?.run ? 'Refresh semester' : 'Initialize courses'}
                </button>
              </div>

              {canvasInitialization?.run && (
                <div className="mt-4 rounded-lg bg-paper-sunk p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium capitalize text-fg1">
                      {canvasInitialization.run.status === 'running'
                        ? `Scanning course ${Math.min(canvasInitialization.run.coursesCompleted + 1, canvasInitialization.run.coursesTotal || 1)} of ${canvasInitialization.run.coursesTotal || '…'}`
                        : canvasInitialization.run.status.replace('_', ' ')}
                    </span>
                    <span className="text-fg3">
                      {canvasInitialization.run.syllabiStored} syllabus {canvasInitialization.run.syllabiStored === 1 ? 'copy' : 'copies'} saved
                    </span>
                  </div>
                  {canvasInitialization.run.coursesTotal > 0 && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-primary-500 transition-all"
                        style={{
                          width: `${Math.min(100, (canvasInitialization.run.coursesCompleted / canvasInitialization.run.coursesTotal) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {canvasInitialization.run.errorMessage && (
                    <p className="mt-2 text-danger-600">{canvasInitialization.run.errorMessage}</p>
                  )}
                </div>
              )}

              {canvasInitialization && canvasInitialization.courses.filter((course) => course.isActive).length > 0 && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {canvasInitialization.courses.filter((course) => course.isActive).map((course) => (
                    <a
                      key={course.courseId}
                      href={course.courseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-line p-3 transition-colors hover:bg-surface-tint"
                    >
                      <p className="truncate text-sm font-semibold text-fg1">{course.courseName}</p>
                      <p className="mt-1 text-xs text-fg3">
                        {course.syllabusStatus === 'stored'
                          ? `Syllabus saved${course.externalSystems.length ? ` · ${course.externalSystems.length} external ${course.externalSystems.length === 1 ? 'system' : 'systems'}` : ''}`
                          : course.syllabusStatus === 'not_found'
                            ? 'No syllabus found yet'
                            : 'Syllabus needs review'}
                      </p>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-info-100 text-info-600">
              <Calendar className="h-6 w-6" strokeWidth={1.85} />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-fg1">Google Calendar</h3>
              <p className="mt-0.5 text-base text-fg3">Read and manage your academic calendar</p>
            </div>
          </div>
          <StatusBadge connected={googleConnected} initialStatus={initialStatus} />
        </div>
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          {(googleEmail || googleIssue) && (
            <p className="text-base text-fg3">{googleIssue || `Connected as ${googleEmail}.`}</p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
          <button
            onClick={() => void connectGoogleCalendar()}
            disabled={connectingGoogle || disconnectingGoogle || initialStatus === 'loading'}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-base font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50 sm:w-auto"
          >
            {initialStatus === 'loading' && !googleConnected ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Checking connection...</>
            ) : connectingGoogle ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Connecting...
              </>
            ) : (
              <>
                {googleConnected ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
                <ExternalLink className="h-3.5 w-3.5" />
              </>
            )}
          </button>
          {(googleConnected || googleEmail) && (
            <button
              type="button"
              onClick={() => void disconnectGoogleCalendar()}
              disabled={connectingGoogle || disconnectingGoogle}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint disabled:opacity-50 sm:w-auto"
            >
              {disconnectingGoogle && <Loader2 className="h-4 w-4 animate-spin" />}
              {disconnectingGoogle ? 'Disconnecting...' : 'Disconnect Google Calendar'}
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
