import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const background = readFileSync(new URL('../../../extensions/canvas-connector/background.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('../../../extensions/canvas-connector/content.js', import.meta.url), 'utf8');

type AlarmState = { creations: number; getError?: Error; alarm?: { name: string; scheduledTime: number; periodInMinutes: number } };

function fixture(alarmState: AlarmState = { creations: 0 }) {
  const stored: Record<string, unknown> = { stufloCanvasHost: 'school.instructure.com', stufloCanvasLastSyncAt: 0 };
  let cookies = [{ name: '_normandy_session', value: 'first', domain: 'school.instructure.com', path: '/', hostOnly: true }];
  const changed = vi.fn();
  const chrome = {
    storage: { local: { get: vi.fn(async () => ({ ...stored })), set: vi.fn(async (value) => Object.assign(stored, value)) } },
    permissions: { contains: vi.fn(async () => true) },
    cookies: { getAll: vi.fn(async () => cookies), onChanged: { addListener: changed } },
    tabs: {
      query: vi.fn(async (): Promise<Array<{ id: number; url: string; incognito?: boolean }>> => [{ id: 1, url: 'https://app.stuflo.com/dashboard/connections' }]),
      sendMessage: vi.fn(async (_tabId: number, _payload: unknown) => ({ ok: true, status: 200 })),
      create: vi.fn(), onUpdated: { addListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn() },
    runtime: { id: 'connector', getURL: (path: string) => `chrome-extension://connector/${path}`, onStartup: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() } },
    alarms: {
      get: vi.fn(async (name: string) => {
        if (alarmState.getError) throw alarmState.getError;
        return alarmState.alarm?.name === name ? alarmState.alarm : undefined;
      }),
      create: vi.fn(async (name: string, info: { periodInMinutes: number }) => {
        alarmState.creations += 1;
        alarmState.alarm = { name, periodInMinutes: info.periodInMinutes, scheduledTime: Date.now() + info.periodInMinutes * 60_000 };
      }),
      onAlarm: { addListener: vi.fn() },
    },
  };
  const context = createContext({ chrome, Date, URL, Map, Set, Promise, setTimeout, clearTimeout });
  runInContext(background, context);
  return { chrome, stored, context, alarmState, run: (value: string) => runInContext(value, context), rotate: () => { cookies = [{ ...cookies[0], value: 'rotated' }]; } };
}

afterEach(() => vi.useRealTimers());

describe('Canvas connector lifecycle', () => {
  it('refreshes a real Normandy session and preserves its host-only scope', async () => {
    const f = fixture();
    await f.run('refreshCanvasConnection({ force: true })');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({
      cookies: [{ name: '_normandy_session', hostOnly: true }], canvasUrl: 'school.instructure.com',
    });
    expect(f.stored.stufloCanvasLastSyncAt).toBeGreaterThan(0);
  });

  it('debounces Normandy cookie rotations into one refresh', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const changed = f.chrome.cookies.onChanged.addListener.mock.calls[0][0];
    const change = { removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } };
    changed(change); changed(change); changed(change);
    await vi.advanceTimersByTimeAsync(500);
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shares repeated manual connects instead of overlapping uploads', async () => {
    const f = fixture();
    await f.run("Promise.all([connectCanvasHost('school.instructure.com'), connectCanvasHost('school.instructure.com'), connectCanvasHost('school.instructure.com')])");
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reads fresh cookies for a follow-up rotation while an upload is pending', async () => {
    const f = fixture();
    let finish!: (value: { ok: boolean; status: number }) => void;
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = f.run('refreshCanvasConnection({ force: true })');
    await vi.waitFor(() => expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1));
    f.rotate();
    const second = f.run("refreshCanvasConnection({ force: true, reason: 'cookie' })");
    finish({ ok: true, status: 200 });
    await Promise.all([first, second]);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.chrome.tabs.sendMessage.mock.calls[1][1]).toMatchObject({ cookies: [{ value: 'rotated' }], refreshReason: 'cookie' });
  });

  it('keeps failed uploads eligible for a future retry', async () => {
    const f = fixture();
    f.chrome.tabs.sendMessage.mockResolvedValueOnce({ ok: false, status: 401 });
    await f.run('refreshCanvasConnection({ force: true })');
    expect(f.stored.stufloCanvasLastSyncAt).toBe(0);
    await f.run('refreshCanvasConnection()');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not send child-domain cookies to the connected parent host', async () => {
    const f = fixture();
    expect(f.run("cookieMatchesHost({ domain: 'child.school.instructure.com' }, 'school.instructure.com')")).toBe(false);
    expect(f.run("cookieMatchesHost({ domain: 'instructure.com', hostOnly: true }, 'school.instructure.com')")).toBe(false);
  });

  it('refuses explicit connects from another extension or an app content script', () => {
    const f = fixture();
    const listener = f.chrome.runtime.onMessage.addListener.mock.calls[0][0];
    for (const sender of [{ id: 'other', url: 'chrome-extension://other/popup.html' }, { id: 'connector', url: 'https://app.stuflo.com/dashboard' }]) {
      expect(listener({ type: 'STUFLO_CONNECT_CANVAS_REQUEST', canvasHost: 'school.instructure.com' }, sender, vi.fn())).toBe(false);
    }
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['', 'school.instructure.com/steal', 'user:password@school.instructure.com', '[bad-host'])('handles malformed connect hosts without reading browser cookies: %s', (canvasHost) => {
    const f = fixture();
    const listener = f.chrome.runtime.onMessage.addListener.mock.calls[0][0];
    const response = vi.fn();
    expect(listener({ type: 'STUFLO_CONNECT_CANVAS_REQUEST', canvasHost }, { id: 'connector', url: 'chrome-extension://connector/popup.html' }, response)).toBe(false);
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(f.chrome.cookies.getAll).not.toHaveBeenCalled();
  });

  it('does not refresh an unrelated Canvas host after another school rotates cookies', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const changed = f.chrome.cookies.onChanged.addListener.mock.calls[0][0];
    changed({ removed: false, cookie: { name: 'canvas_session', domain: 'other.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('checks permission before reading cookies and leaves the saved connection unchanged', async () => {
    const f = fixture();
    f.chrome.permissions.contains.mockResolvedValueOnce(false);
    await expect(f.run("connectCanvasHost('school.instructure.com')")).resolves.toMatchObject({ ok: false });
    expect(f.chrome.cookies.getAll).not.toHaveBeenCalled();
    expect(f.stored.stufloCanvasHost).toBe('school.instructure.com');
  });

  it('recovers the queue after both the receiver and reinjection fail', async () => {
    const f = fixture();
    f.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('No receiver')).mockRejectedValueOnce(new Error('Tab closed'));
    await expect(f.run("connectCanvasHost('school.instructure.com')")).rejects.toThrow('Tab closed');
    await expect(f.run("connectCanvasHost('school.instructure.com')")).resolves.toMatchObject({ ok: true });
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('bounds a continuous cookie-rotation burst to one follow-up upload', async () => {
    const f = fixture();
    f.chrome.tabs.sendMessage.mockImplementation(async () => {
      f.run('refreshCanvasConnection({ force: true })');
      return { ok: true, status: 200 };
    });
    await f.run('refreshCanvasConnection({ force: true })');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('registers only one receiver when content.js is reinjected', () => {
    const addListener = vi.fn();
    const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } } });
    runInContext(content, context); runInContext(content, context);
    expect(addListener).toHaveBeenCalledTimes(1);
    const listener = addListener.mock.calls[0][0];
    expect(listener({ type: 'STUFLO_CONNECT_CANVAS' }, { id: 'other-extension' }, vi.fn())).toBe(false);
  });

  it('keeps normal-store Canvas cookies out of incognito StuFlo tabs', async () => {
    const f = fixture();
    f.chrome.tabs.query.mockResolvedValueOnce([
      { id: 2, url: 'https://app.stuflo.com/dashboard/connections', incognito: true },
      { id: 3, url: 'https://app.stuflo.com/dashboard/connections', incognito: false },
    ]);
    await f.run("connectCanvasHost('school.instructure.com')");
    expect(f.chrome.tabs.sendMessage.mock.calls[0][0]).toBe(3);
  });

  it('does not upload when only incognito StuFlo is open', async () => {
    const f = fixture();
    f.chrome.tabs.query.mockResolvedValueOnce([{ id: 2, url: 'https://app.stuflo.com/dashboard', incognito: true }]);
    await expect(f.run('refreshCanvasConnection({ force: true })')).resolves.toBeUndefined();
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(f.chrome.cookies.getAll).not.toHaveBeenCalled();
  });

  it('releases a hung message bridge so the next manual reconnect can run', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise(() => undefined));
    let settled = false;
    const pending = f.run("connectCanvasHost('school.instructure.com')");
    pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(settled).toBe(true);
    expect(f.stored.stufloCanvasLastSyncAt).toBe(0);
    await expect(f.run("connectCanvasHost('school.instructure.com')")).resolves.toMatchObject({ ok: true });
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('never reinjects or retries a timed-out bridge after its old promise later rejects', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let rejectLate!: (error: Error) => void;
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise((_, reject) => { rejectLate = reject; }));
    const pending = f.run("connectCanvasHost('school.instructure.com')");
    const result = pending.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await result).toContain('timed out');
    rejectLate(new Error('Could not establish connection. Receiving end does not exist.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not retry an unknown closed-port upload outcome', async () => {
    const f = fixture();
    f.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('The message port closed before a response was received.'));
    await expect(f.run("connectCanvasHost('school.instructure.com')")).rejects.toThrow('message port closed');
    expect(f.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    await expect(f.run("connectCanvasHost('school.instructure.com')")).resolves.toMatchObject({ ok: true });
  });

  it('opens StuFlo only for a manual connect and keeps missing-tab background alarms quiet', async () => {
    const f = fixture();
    f.chrome.tabs.query.mockResolvedValue([]);
    await f.run('refreshCanvasConnection()');
    expect(f.chrome.tabs.create).not.toHaveBeenCalled();
    await expect(f.run("connectCanvasHost('school.instructure.com')")).resolves.toMatchObject({ ok: false });
    expect(f.chrome.tabs.create).toHaveBeenCalledOnce();
    expect(f.chrome.cookies.getAll).not.toHaveBeenCalled();
    expect(f.stored.stufloCanvasLastSyncAt).toBe(0);
  });

  it('continues an existing0.3 saved host without an initial manual reconnect', async () => {
    const f = fixture();
    f.stored.stufloCanvasLastSyncAt = Date.now() - 10 * 60_000;
    const alarm = f.chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    alarm({ name: 'stuflo-canvas-refresh' });
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(f.stored.stufloCanvasHost).toBe('school.instructure.com');
  });

  it('preserves a persisted alarm deadline across unrelated-tab service-worker restarts', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const alarmState: AlarmState = { creations: 0 };
    fixture(alarmState);
    await vi.advanceTimersByTimeAsync(0);
    const firstDeadline = alarmState.alarm?.scheduledTime;
    for (let minute = 1; minute <= 10; minute++) {
      vi.setSystemTime(startedAt + minute * 60_000);
      const f = fixture(alarmState);
      const tabUpdated = f.chrome.tabs.onUpdated.addListener.mock.calls[0][0];
      tabUpdated(5, { status: 'complete' }, { url: 'https://example.org/unrelated' });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    }
    expect(alarmState.creations).toBe(1);
    expect(alarmState.alarm?.scheduledTime).toBe(firstDeadline);
  });

  it('recreates a missing alarm on worker wake and replaces an incorrect period once', async () => {
    vi.useFakeTimers();
    const alarmState: AlarmState = { creations: 0,
      alarm: { name: 'stuflo-canvas-refresh', periodInMinutes: 1, scheduledTime: Date.now() + 60_000 } };
    fixture(alarmState);
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmState.alarm?.periodInMinutes).toBe(5);
    expect(alarmState.creations).toBe(1);
    alarmState.alarm = undefined; // Chrome may discard alarms on session/update changes.
    fixture(alarmState);
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmState.creations).toBe(2);
    expect(alarmState.alarm).toMatchObject({ periodInMinutes: 5 });
  });

  it('refreshes on consecutive periodic ticks despite two seconds of successful upload latency', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const f = fixture();
    f.chrome.tabs.sendMessage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { ok: true, status: 200 };
    });
    const connect = f.run("connectCanvasHost('school.instructure.com')");
    await vi.advanceTimersByTimeAsync(2_000); await connect;
    const alarm = f.chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    for (let tick = 1; tick <= 3; tick++) {
      vi.setSystemTime(startedAt + tick * 300_000);
      alarm({ name: 'stuflo-canvas-refresh' });
      await vi.advanceTimersByTimeAsync(2_000);
      await f.run('refreshPromise');
      expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(tick + 1);
    }
  });

  it.each([234_999, 235_000, 298_000])('limits periodic due grace to65seconds after success: elapsed%sms', async (elapsed) => {
    const f = fixture();
    f.stored.stufloCanvasLastSyncAt = Date.now() - elapsed;
    const alarm = f.chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    alarm({ name: 'stuflo-canvas-refresh' });
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(elapsed >= 235_000 ? 1 : 0);
  });

  it('does not use periodic grace on a Canvas tab reload, but keeps StuFlo opening forced', async () => {
    const f = fixture();
    f.stored.stufloCanvasLastSyncAt = Date.now() - 298_000;
    const tabUpdated = f.chrome.tabs.onUpdated.addListener.mock.calls[0][0];
    tabUpdated(7, { status: 'complete' }, { url: 'https://school.instructure.com/dashboard' });
    // The event checks saved host asynchronously before starting refreshPromise.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    f.stored.stufloCanvasLastSyncAt = Date.now();
    tabUpdated(1, { status: 'complete' }, { url: 'https://app.stuflo.com/dashboard' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
  });

  it('retains alarm grace when an alarm arrives during an in-flight strict refresh that skips', async () => {
    const f = fixture();
    f.stored.stufloCanvasLastSyncAt = Date.now() - 298_000;
    let finishPermission!: (value: boolean) => void;
    f.chrome.permissions.contains.mockImplementationOnce(() => new Promise((resolve) => { finishPermission = resolve; }));
    const strictRefresh = f.run("refreshCanvasConnection({ reason: 'canvas-tab' })");
    await vi.waitFor(() => expect(f.chrome.permissions.contains).toHaveBeenCalledOnce());
    f.chrome.alarms.onAlarm.addListener.mock.calls[0][0]({ name: 'stuflo-canvas-refresh' });
    finishPermission(true);
    await strictRefresh;
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(f.chrome.permissions.contains).toHaveBeenCalledTimes(2);
    expect(f.chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ refreshReason: 'alarm' });
  });

  it.each([
    { reason: 'canvas-tab', age: 298_000, expected: 'alarm' },
    { reason: 'startup', age: 298_000, expected: 'alarm' },
    { reason: 'canvas-tab', age: 300_000, expected: 'canvas-tab' },
  ])('attributes merged alarm grace only when it enables a strict upload: %j', async ({ reason, age, expected }) => {
    vi.useFakeTimers();
    const f = fixture();
    f.stored.stufloCanvasLastSyncAt = Date.now() - age;
    let finishHostLookup!: (value: Record<string, unknown>) => void;
    f.chrome.storage.local.get.mockImplementationOnce(() => new Promise((resolve) => { finishHostLookup = resolve; }));
    const strict = f.run(`refreshCanvasConnection({ reason: '${reason}' })`);
    await vi.advanceTimersByTimeAsync(0);
    f.chrome.alarms.onAlarm.addListener.mock.calls[0][0]({ name: 'stuflo-canvas-refresh' });
    finishHostLookup({ ...f.stored });
    await strict;
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(f.chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ refreshReason: expected });
  });

  it('does not send a follow-up solely for an alarm that arrives during a healthy upload', async () => {
    const f = fixture();
    let finishUpload!: (value: { ok: boolean; status: number }) => void;
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
    const pending = f.run('refreshCanvasConnection({ force: true })');
    await vi.waitFor(() => expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce());
    f.chrome.alarms.onAlarm.addListener.mock.calls[0][0]({ name: 'stuflo-canvas-refresh' });
    finishUpload({ ok: true, status: 200 });
    await pending;
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
  });

  it('retains a forced cookie refresh while its strict refresh is queued behind a manual connect', async () => {
    const f = fixture();
    let finishManual!: (value: { ok: boolean; status: number }) => void;
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishManual = resolve; }));
    const manual = f.run("connectCanvasHost('school.instructure.com')");
    await vi.waitFor(() => expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce());
    const strictQueued = f.run("refreshCanvasConnection({ reason: 'canvas-tab' })");
    f.rotate();
    const forcedQueued = f.run("refreshCanvasConnection({ force: true, reason: 'cookie' })");
    finishManual({ ok: true, status: 200 });
    await Promise.all([manual, strictQueued, forcedQueued]);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.chrome.tabs.sendMessage.mock.calls[1][1]).toMatchObject({ cookies: [{ value: 'rotated' }], refreshReason: 'cookie' });
  });

  it.each(['two-pass cookie churn', 'failed upload'])('does not carry force from %s into a recent periodic refresh', async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    f.stored.stufloCanvasLastSyncAt = Date.now() - 1_000;
    let forceDuringUpload = true;
    f.chrome.tabs.sendMessage.mockImplementation(async () => {
      if (forceDuringUpload) f.run('refreshCanvasConnection({ force: true })');
      const ok = mode === 'two-pass cookie churn' || !forceDuringUpload;
      return { ok, status: ok ? 200 : 503 };
    });
    await f.run('refreshCanvasConnection({ force: true })');
    const previousPosts = mode === 'two-pass cookie churn' ? 2 : 1;
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(previousPosts);
    forceDuringUpload = false;
    vi.setSystemTime(Number(f.stored.stufloCanvasLastSyncAt) + 103_000);
    f.chrome.alarms.onAlarm.addListener.mock.calls[0][0]({ name: 'stuflo-canvas-refresh' });
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(previousPosts);
    // A new rotation after the completed task still gets its own forced sync.
    f.chrome.cookies.onChanged.addListener.mock.calls[0][0]({ removed: false,
      cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(500);
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(previousPosts + 1);
  });

  it('keeps listeners and manual connection available when alarm lookup fails', async () => {
    vi.useFakeTimers();
    const f = fixture({ creations: 0, getError: new Error('Alarm API unavailable') });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.chrome.alarms.onAlarm.addListener).toHaveBeenCalledOnce();
    expect(f.chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
    expect(f.chrome.alarms.create).not.toHaveBeenCalled();
    await expect(f.run("connectCanvasHost('school.instructure.com')")).resolves.toMatchObject({ ok: true });
  });

  it.each(['manual', 'cookie', 'canvas-tab', 'stuflo-tab', 'alarm', 'startup'])('labels the upload initiated by %s', async (reason) => {
    vi.useFakeTimers();
    const f = fixture();
    if (reason === 'manual') await f.run("connectCanvasHost('school.instructure.com')");
    else if (reason === 'cookie') {
      f.chrome.cookies.onChanged.addListener.mock.calls[0][0]({ removed: false,
        cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
      await vi.advanceTimersByTimeAsync(500);
    } else if (reason === 'canvas-tab' || reason === 'stuflo-tab') {
      if (reason === 'stuflo-tab') f.stored.stufloCanvasLastSyncAt = Date.now();
      const url = reason === 'canvas-tab' ? 'https://school.instructure.com/dashboard' : 'https://app.stuflo.com/dashboard';
      f.chrome.tabs.onUpdated.addListener.mock.calls[0][0](1, { status: 'complete' }, { url });
      await vi.advanceTimersByTimeAsync(0);
    } else if (reason === 'alarm') f.chrome.alarms.onAlarm.addListener.mock.calls[0][0]({ name: 'stuflo-canvas-refresh' });
    else f.chrome.runtime.onStartup.addListener.mock.calls[0][0]();
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(f.chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ refreshReason: reason });
  });

  it.each(['response', 'transport'])('invalidates a pre-failure cookie host lookup when a manual upload fails by %s', async (failure) => {
    vi.useFakeTimers();
    const f = fixture();
    let finishUpload!: () => void;
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishUpload = () => failure === 'response' ? resolve({ ok: false, status: 503 }) : reject(new Error('Network lost'));
    }));
    const upload = f.run("connectCanvasHost('school.instructure.com')").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    let finishHostLookup!: (value: Record<string, unknown>) => void;
    f.chrome.storage.local.get.mockImplementationOnce(() => new Promise((resolve) => { finishHostLookup = resolve; }));
    const cookieChanged = f.chrome.cookies.onChanged.addListener.mock.calls[0][0];
    cookieChanged({ removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(0);
    finishUpload(); await upload;
    finishHostLookup({ ...f.stored });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    // Post-failure events are independent and remain eligible for recovery.
    cookieChanged({ removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(500);
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.chrome.tabs.sendMessage.mock.calls[1][1]).toMatchObject({ refreshReason: 'cookie' });
  });

  it('drops a pre-failure cookie task already queued behind a failed manual upload', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finishManual!: (value: { ok: boolean; status: number }) => void;
    f.chrome.tabs.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishManual = resolve; }));
    const manual = f.run("connectCanvasHost('school.instructure.com')");
    await vi.advanceTimersByTimeAsync(0);
    const cookieChanged = f.chrome.cookies.onChanged.addListener.mock.calls[0][0];
    cookieChanged({ removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(500);
    const queuedCookie = f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    finishManual({ ok: false, status: 503 });
    await Promise.all([manual, queuedCookie]);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    cookieChanged({ removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(500);
    await f.run('refreshPromise');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Response('<html>Unexpected login page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    Response.json({}),
    Response.json({ validation: { data: { connected: true } }, connection: null }),
    Response.json({ validation: { data: { connected: true } }, connection: { canvasHost: 'other.instructure.com', status: 'connected' } }),
  ])('does not claim a saved connection from an unacknowledged HTTP200 body', async (response) => {
    const addListener = vi.fn();
    const sendResponse = vi.fn();
    const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } },
      fetch: vi.fn(async () => response.clone()), AbortController, setTimeout, clearTimeout, Promise, JSON });
    runInContext(content, context);
    const listener = addListener.mock.calls[0][0];
    listener({ type: 'STUFLO_CONNECT_CANVAS', canvasUrl: 'school.instructure.com', cookies: [] }, { id: 'connector' }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse.mock.calls[0][0].ok).toBe(false);
  });

  it('requires Canvas verification and persisted connection acknowledgment for success', async () => {
    const addListener = vi.fn();
    const sendResponse = vi.fn();
    const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } },
      fetch: vi.fn(async () => Response.json({ validation: { data: { connected: true } },
        connection: { canvasHost: 'school.instructure.com', status: 'connected' } })),
      AbortController, setTimeout, clearTimeout, Promise, JSON });
    runInContext(content, context);
    addListener.mock.calls[0][0]({ type: 'STUFLO_CONNECT_CANVAS', canvasUrl: 'school.instructure.com', cookies: [] }, { id: 'connector' }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse.mock.calls[0][0].ok).toBe(true);
  });

  it('aborts a stalled content fetch and reports one failure without another POST', async () => {
    vi.useFakeTimers();
    const addListener = vi.fn();
    const sendResponse = vi.fn();
    const fetcher = vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } },
      fetch: fetcher, AbortController, setTimeout, clearTimeout, Promise, JSON });
    runInContext(content, context);
    addListener.mock.calls[0][0]({ type: 'STUFLO_CONNECT_CANVAS', canvasUrl: 'school.instructure.com', cookies: [] }, { id: 'connector' }, sendResponse);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledOnce();
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not immediately retry a timed-out upload after refresh notifications queued during it', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const addListener = vi.fn();
    const fetcher = vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } },
      fetch: fetcher, AbortController, setTimeout, clearTimeout, Promise, JSON });
    runInContext(content, context);
    f.chrome.tabs.sendMessage.mockImplementationOnce((_tab, payload) => new Promise((resolve) => {
      addListener.mock.calls[0][0](payload, { id: 'connector' }, resolve);
    }));
    const first = f.run('refreshCanvasConnection({ force: true })');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    const queued = f.run('refreshCanvasConnection({ force: true })');
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([first, queued]);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(f.stored.stufloCanvasLastSyncAt).toBe(0);
    expect(f.chrome.scripting.executeScript).not.toHaveBeenCalled();
    await f.run('refreshCanvasConnection({ force: true })');
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.stored.stufloCanvasLastSyncAt).toBeGreaterThan(0);
  });

  it.each(['manual', 'automatic'])('cancels a cookie debounce armed before a 60-second %s upload abort', async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    const addListener = vi.fn();
    let fetchCalls = 0;
    const fetcher = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      fetchCalls += 1;
      if (fetchCalls > 1) return Promise.resolve(Response.json({ validation: { data: { connected: true } },
        connection: { canvasHost: 'school.instructure.com', status: 'connected' } }));
      return new Promise<Response>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } },
      fetch: fetcher, AbortController, setTimeout, clearTimeout, Promise, JSON });
    runInContext(content, context);
    f.chrome.tabs.sendMessage.mockImplementation((_tab, payload) => new Promise((resolve) => {
      addListener.mock.calls[0][0](payload, { id: 'connector' }, resolve);
    }));
    const first = mode === 'manual' ? f.run("connectCanvasHost('school.instructure.com')") : f.run('refreshCanvasConnection({ force: true })');
    await vi.advanceTimersByTimeAsync(59_600);
    const cookieChanged = f.chrome.cookies.onChanged.addListener.mock.calls[0][0];
    cookieChanged({ removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(400); await first;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(f.stored.stufloCanvasLastSyncAt).toBe(0);
    cookieChanged({ removed: false, cookie: { name: '_normandy_session', domain: 'school.instructure.com', hostOnly: true } });
    await vi.advanceTimersByTimeAsync(500);
    await f.run('refreshPromise');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.chrome.tabs.sendMessage.mock.calls[1][1]).toMatchObject({ refreshReason: 'cookie' });
    expect(f.stored.stufloCanvasLastSyncAt).toBeGreaterThan(0);
  });
});
