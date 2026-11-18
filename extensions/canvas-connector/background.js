const STUFLO_APP_PATTERN = 'https://app.stuflo.com/*';
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_ALARM = 'stuflo-canvas-refresh';
const CONNECT_BRIDGE_TIMEOUT_MS = 65 * 1000;
const SESSION_COOKIE_NAMES = new Set(['canvas_session', '_normandy_session', '_csrf_token']);
const REFRESH_REASONS = new Set(['manual', 'cookie', 'canvas-tab', 'stuflo-tab', 'alarm', 'startup']);
let syncQueue = Promise.resolve();
let refreshPromise = null;
let refreshAgain = false;
let refreshDueGraceMs = 0;
let refreshForcedReason = null;
let refreshForcedCookieGeneration = null;
let cookieRefreshTimer = null;
let cookieRefreshGeneration = 0;
const manualConnections = new Map();

function mapSameSite(value) {
  if (value === 'strict') return 'Strict';
  if (value === 'lax') return 'Lax';
  if (value === 'no_restriction') return 'None';
  return undefined;
}

function toCanvasCookie(cookie) {
  const mapped = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
    secure: Boolean(cookie.secure),
  };
  if (typeof cookie.expirationDate === 'number') mapped.expires = cookie.expirationDate;
  const sameSite = mapSameSite(cookie.sameSite);
  if (sameSite) mapped.sameSite = sameSite;
  return mapped;
}

function cookieMatchesHost(cookie, hostname) {
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return hostname === domain || (!cookie.hostOnly && hostname.endsWith(`.${domain}`));
}

function dedupeCookies(cookies) {
  const seen = new Map();
  for (const cookie of cookies) seen.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
  return [...seen.values()];
}

async function savedCanvasHost() {
  const stored = await chrome.storage.local.get(['stufloCanvasHost']);
  return typeof stored.stufloCanvasHost === 'string' ? stored.stufloCanvasHost : '';
}

async function hasCanvasPermission(hostname) {
  return chrome.permissions.contains({ origins: [`https://${hostname}/*`] });
}

async function getCanvasCookies(hostname) {
  const [byUrl, byDomain] = await Promise.all([
    chrome.cookies.getAll({ url: `https://${hostname}/` }),
    chrome.cookies.getAll({ domain: hostname }),
  ]);
  return dedupeCookies([...byUrl, ...byDomain])
    .filter((cookie) => cookieMatchesHost(cookie, hostname))
    .map(toCanvasCookie);
}

async function getStuFloTab() {
  const tabs = await chrome.tabs.query({ url: [STUFLO_APP_PATTERN] });
  // Cookie reads use this extension's normal store. Never upload those sessions
  // into an incognito StuFlo account until explicit cookie-store support exists.
  const normalTabs = tabs.filter((tab) => !tab.incognito);
  return normalTabs.find((tab) => tab.url?.includes('/dashboard')) || normalTabs[0] || null;
}

async function sendToStuFlo(tab, payload) {
  let expired = false;
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      expired = true;
      reject(new Error('Canvas connection timed out. Keep StuFlo open and signed in, then try again.'));
    }, CONNECT_BRIDGE_TIMEOUT_MS);
  });
  const send = async () => {
    try {
      return await chrome.tabs.sendMessage(tab.id, payload);
    } catch (error) {
      // Reinject only when there was no receiver, which means no upload ran.
      // A closed message port or timed-out upload has an unknown outcome.
      if (expired || !/receiving end does not exist|could not establish connection|no receiver/i.test(error?.message || String(error))) throw error;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      if (expired) throw new Error('Canvas connection timed out before the receiver became ready.');
      return chrome.tabs.sendMessage(tab.id, payload);
    }
  };
  try {
    return await Promise.race([send(), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function discardPendingCookieRefresh() {
  cookieRefreshGeneration += 1;
  clearTimeout(cookieRefreshTimer);
  cookieRefreshTimer = null;
}

function canvasSyncFailure(error) {
  discardPendingCookieRefresh();
  return { ok: false, error };
}

async function syncCanvasHost(hostname, { force = false, explicit = false, dueGraceMs = 0, reason = 'startup' } = {}) {
  try {
    if (!hostname || !(await hasCanvasPermission(hostname))) {
      return canvasSyncFailure('Grant Canvas permission first, then connect.');
    }

    const stored = await chrome.storage.local.get(['stufloCanvasLastSyncAt']);
    const lastSyncAt = Number(stored.stufloCanvasLastSyncAt || 0);
    const grace = Math.min(CONNECT_BRIDGE_TIMEOUT_MS, Math.max(0, dueGraceMs));
    const elapsedMs = Date.now() - lastSyncAt;
    if (!force && elapsedMs < MIN_SYNC_INTERVAL_MS - grace) return { ok: true, skipped: true };
    const uploadReason = !force && grace > 0 && elapsedMs < MIN_SYNC_INTERVAL_MS ? 'alarm' : reason;

    const stufloTab = await getStuFloTab();
    if (!stufloTab) {
      if (explicit) await chrome.tabs.create({ url: 'https://app.stuflo.com/dashboard/connections' });
      return canvasSyncFailure('Open StuFlo, sign in, then connect Canvas again.');
    }

    const cookies = await getCanvasCookies(hostname);
    if (!cookies.length) return canvasSyncFailure('No Canvas cookies found. Make sure Canvas is fully signed in.');

    const response = await sendToStuFlo(stufloTab, {
      type: 'STUFLO_CONNECT_CANVAS',
      canvasUrl: hostname,
      cookies,
      refreshReason: REFRESH_REASONS.has(uploadReason) ? uploadReason : 'startup',
    });
    if (response?.ok) {
      await chrome.storage.local.set({ stufloCanvasHost: hostname, stufloCanvasLastSyncAt: Date.now() });
    } else {
      discardPendingCookieRefresh();
    }
    return { ...response, cookieCount: cookies.length };
  } catch (error) {
    discardPendingCookieRefresh();
    throw error;
  }
}

function queueSync(task) {
  const queued = syncQueue.catch(() => undefined).then(task);
  syncQueue = queued;
  return queued;
}

function connectCanvasHost(hostname) {
  if (manualConnections.has(hostname)) return manualConnections.get(hostname);
  const pending = queueSync(() => syncCanvasHost(hostname, { force: true, explicit: true, reason: 'manual' }))
    .finally(() => manualConnections.delete(hostname));
  manualConnections.set(hostname, pending);
  return pending;
}

function refreshCanvasConnection({ force = false, dueGraceMs = 0, reason = 'startup', cookieGeneration = cookieRefreshGeneration } = {}) {
  if (refreshPromise) {
    if (force) {
      refreshAgain = true;
      refreshForcedReason = reason;
      refreshForcedCookieGeneration = reason === 'cookie' ? cookieGeneration : null;
    }
    refreshDueGraceMs = Math.max(refreshDueGraceMs, dueGraceMs);
    return refreshPromise;
  }
  refreshDueGraceMs = dueGraceMs;
  refreshPromise = queueSync(async () => {
    let passes = 0;
    let retryWithGrace = false;
    do {
      // A cookie rotation or StuFlo opening may request force while this task
      // is still queued behind a manual connection. Retain that first pass.
      if (refreshAgain && refreshForcedReason) {
        reason = refreshForcedReason;
        if (reason === 'cookie') cookieGeneration = refreshForcedCookieGeneration;
      }
      force = force || refreshAgain;
      refreshAgain = false;
      refreshForcedReason = null;
      refreshForcedCookieGeneration = null;
      retryWithGrace = false;
      // A failed manual upload can invalidate a cookie task already queued.
      if (reason === 'cookie' && cookieGeneration !== cookieRefreshGeneration) break;
      const hostname = await savedCanvasHost();
      if (hostname) {
        const usedGraceMs = refreshDueGraceMs;
        const response = await syncCanvasHost(hostname, { force, dueGraceMs: usedGraceMs, reason });
        // A queued rotation cannot safely retry a failed or timed-out upload.
        // Leave it eligible for the next separate refresh or manual request.
        if (!response?.ok) break;
        // Preserve a periodic due check that arrived during a stricter pass.
        // A successful upload never needs another pass solely for alarm grace.
        retryWithGrace = response.skipped && refreshDueGraceMs > usedGraceMs;
      }
      if (retryWithGrace && !refreshAgain) reason = 'alarm';
      force = refreshAgain;
      passes += 1;
    } while ((refreshAgain || retryWithGrace) && passes < 2);
  }).finally(() => {
    refreshPromise = null;
    refreshAgain = false;
    refreshDueGraceMs = 0;
    refreshForcedReason = null;
    refreshForcedCookieGeneration = null;
  });
  return refreshPromise;
}

function quietRefresh(options) {
  void refreshCanvasConnection(options).catch(() => undefined);
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.removed || !SESSION_COOKIE_NAMES.has(changeInfo.cookie?.name)) return;
  const generation = cookieRefreshGeneration;
  void savedCanvasHost().then((hostname) => {
    if (generation !== cookieRefreshGeneration) return;
    if (hostname && cookieMatchesHost(changeInfo.cookie, hostname)) {
      clearTimeout(cookieRefreshTimer);
      cookieRefreshTimer = setTimeout(() => {
        cookieRefreshTimer = null;
        if (generation === cookieRefreshGeneration) {
          quietRefresh({ force: true, reason: 'cookie', cookieGeneration: generation });
        }
      }, 500);
    }
  }).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  void savedCanvasHost().then((hostname) => {
    if (!hostname) return;
    try {
      const visitedHost = new URL(tab.url).hostname;
      if (visitedHost === hostname || visitedHost === 'app.stuflo.com') {
        quietRefresh({ force: visitedHost === 'app.stuflo.com', reason: visitedHost === 'app.stuflo.com' ? 'stuflo-tab' : 'canvas-tab' });
      }
    } catch {
      // Ignore non-HTTP browser tabs.
    }
  }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  quietRefresh({ reason: 'startup' });
});

async function ensureRefreshAlarm() {
  const alarm = await chrome.alarms.get(REFRESH_ALARM);
  // Recreating a named alarm replaces its deadline. Preserve it across worker
  // wakes, while repairing alarms Chrome cleared or an older version scheduled.
  if (!alarm || alarm.periodInMinutes !== 5) {
    await chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 5 });
  }
}
void ensureRefreshAlarm().catch(() => undefined);
chrome.alarms.onAlarm.addListener((alarm) => {
  // Completion time lags the previous tick by the upload duration. A bounded
  // grace avoids skipping every other tick without forcing recent refreshes.
  if (alarm.name === REFRESH_ALARM) quietRefresh({ dueGraceMs: CONNECT_BRIDGE_TIMEOUT_MS, reason: 'alarm' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'STUFLO_CONNECT_CANVAS_REQUEST' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const hostname = typeof message.canvasHost === 'string' ? message.canvasHost : '';
  let validHost = false;
  try { validHost = Boolean(hostname) && new URL(`https://${hostname}`).hostname === hostname; } catch { /* invalid host */ }
  if (!validHost) {
    sendResponse({ ok: false, error: 'A valid Canvas host is required.' });
    return false;
  }
  connectCanvasHost(hostname).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
