const connectButton = document.getElementById('connect');
const grantPermissionButton = document.getElementById('grant-permission');
const openStuFloButton = document.getElementById('open-stuflo');
const openPrivacyButton = document.getElementById('open-privacy');
const statusEl = document.getElementById('status');
const hostEl = document.getElementById('host');
const STUFLO_DASHBOARD_URL = 'https://app.stuflo.com/dashboard/connections';
const STUFLO_PRIVACY_URL = 'https://stuflo.com/privacy-policy';
const NORMAL_WINDOW_GUIDANCE = 'Open Canvas and StuFlo in a normal browser window, then connect again. Incognito connections are not supported.';
const UNSUPPORTED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'home.arpa', 'onion', 'lan', 'home', 'corp'];
const UNSUPPORTED_SITE_GUIDANCE = 'Open your signed-in Canvas page on a public HTTPS site. Local sites, IP addresses, URL credentials and custom ports are not supported.';
let currentCanvasUrl = null;
let hasCanvasPermission = false;
let isInitializing = true;
let isGranting = false;
let isConnecting = false;
let operationId = 0;

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function chromeCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function permissionPattern(url) {
  return `${url.origin}/*`;
}

function setBusy(isBusy) {
  isConnecting = isBusy;
  connectButton.textContent = isBusy ? 'Connecting...' : 'Connect Canvas to StuFlo';
  updatePermissionUi();
}

function updatePermissionUi() {
  const onCanvas = Boolean(currentCanvasUrl);
  const isBusy = isInitializing || isGranting || isConnecting;
  grantPermissionButton.disabled = isBusy || !onCanvas || hasCanvasPermission;
  connectButton.disabled = isBusy || !onCanvas || !hasCanvasPermission;
  grantPermissionButton.textContent = hasCanvasPermission ? 'Canvas permission granted' : 'Grant Canvas permission';
}

async function getActiveTab() {
  const tabs = await chromeCall(chrome.tabs.query, { active: true, currentWindow: true });
  return tabs?.[0] || null;
}

function isSupportedCanvasSite(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  // Custom university domains need not contain "canvas" or "instructure".
  // This permits an explicit connection attempt, not automatic Canvas detection.
  const hostname = url.hostname;
  if (!hostname || hostname.length > 253 || hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(hostname)) return false;
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  return !UNSUPPORTED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function canvasUrlFromTab(tab) {
  if (!tab?.url) throw new Error('Open your logged-in Canvas tab first.');
  if (tab.incognito) throw new Error(NORMAL_WINDOW_GUIDANCE);
  const url = new URL(tab.url);
  if (url.protocol !== 'https:') throw new Error('Canvas must be open over HTTPS.');
  if (!isSupportedCanvasSite(url)) throw new Error(UNSUPPORTED_SITE_GUIDANCE);
  return url;
}

async function hasPermissionForCanvas(url) {
  return chromeCall(chrome.permissions.contains, { origins: [permissionPattern(url)] });
}

function describeFailure(response) {
  const code = response?.data?.code || response?.data?.errorCode || response?.data?.error;
  if (response?.status === 401 && (response?.data?.status === 'not_logged_in' ||
    ['session_expired', 'not_connected', 'permission_denied'].includes(code))) {
    return 'Canvas did not accept this session. Make sure the Canvas tab is fully signed in, then try again.';
  }
  if (response?.status === 401) {
    return 'StuFlo is not signed in. Open the StuFlo dashboard in another tab, sign in, then try again.';
  }
  if (response?.status === 413) {
    return 'Canvas returned too many cookies for StuFlo to accept. Reload Canvas and try again.';
  }
  if (response?.data?.error) return response.data.error;
  if (response?.error) return response.error;
  return 'StuFlo rejected the Canvas session.';
}

async function resolveActiveCanvasTab() {
  const activeTab = await getActiveTab();
  try {
    return canvasUrlFromTab(activeTab);
  } catch (error) {
    currentCanvasUrl = null;
    hasCanvasPermission = false;
    throw error;
  }
}

async function grantPermission() {
  if (isInitializing || isGranting || isConnecting) return;
  operationId += 1;
  isGranting = true;
  updatePermissionUi();
  setStatus('Checking this Canvas tab...', 'pending');

  try {
    const url = await resolveActiveCanvasTab();
    currentCanvasUrl = url;
    hostEl.textContent = url.hostname;

    hasCanvasPermission = await hasPermissionForCanvas(url);
    if (!hasCanvasPermission) {
      setStatus('Chrome will ask you to allow StuFlo access to this Canvas site.', 'pending');
      hasCanvasPermission = await chromeCall(chrome.permissions.request, { origins: [permissionPattern(url)] });
    }

    if (!hasCanvasPermission) {
      throw new Error('Canvas permission was not granted. Click Grant Canvas permission and choose Allow.');
    }

    setStatus('Permission granted. Connect only from your signed-in Canvas page; StuFlo will validate its session.', 'ok');
  } catch (error) {
    hasCanvasPermission = false;
    setStatus(error?.message || String(error), 'error');
  } finally {
    isGranting = false;
    updatePermissionUi();
  }
}

async function connect() {
  if (isInitializing || isGranting || isConnecting) return;
  operationId += 1;
  setBusy(true);
  setStatus('Preparing connection...', 'pending');

  try {
    const url = await resolveActiveCanvasTab();
    currentCanvasUrl = url;

    hostEl.textContent = `Canvas: ${url.hostname}`;
    hasCanvasPermission = await hasPermissionForCanvas(url);
    if (!hasCanvasPermission) {
      throw new Error('Grant Canvas permission first, then connect.');
    }

    setStatus('Validating and saving in StuFlo...', 'pending');
    const response = await chromeCall(chrome.runtime.sendMessage, {
      type: 'STUFLO_CONNECT_CANVAS_REQUEST',
      canvasHost: url.hostname,
    });

    if (!response?.ok) {
      throw new Error(describeFailure(response));
    }

    setStatus(`Connected ${response.data?.connection?.canvasHost || response.data?.canvasUrl || url.hostname} with ${response.cookieCount || 0} cookies.`, 'ok');
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function init() {
  if (isGranting || isConnecting) return;
  const initId = ++operationId;
  isInitializing = true;
  updatePermissionUi();
  try {
    const tab = await getActiveTab();
    if (initId !== operationId) return;
    const url = canvasUrlFromTab(tab);
    const permission = await hasPermissionForCanvas(url);
    // Ignore delayed checks from an older initialization after a newer operation.
    if (initId !== operationId) return;
    currentCanvasUrl = url;
    hasCanvasPermission = permission;
    hostEl.textContent = url.hostname;
    setStatus(
      hasCanvasPermission
        ? 'Permission granted. Connect only from your signed-in Canvas page; StuFlo will validate its session.'
        : 'Use your signed-in Canvas page, then grant permission for this site. StuFlo will validate Canvas when you connect.',
      hasCanvasPermission ? 'ok' : 'pending'
    );
  } catch (error) {
    if (initId !== operationId) return;
    currentCanvasUrl = null;
    hasCanvasPermission = false;
    hostEl.textContent = 'Open your Canvas dashboard tab.';
    setStatus(error?.message || String(error), 'error');
  } finally {
    if (initId === operationId) {
      isInitializing = false;
      updatePermissionUi();
    }
  }
}

grantPermissionButton.addEventListener('click', grantPermission);
connectButton.addEventListener('click', connect);
openStuFloButton.addEventListener('click', () => chrome.tabs.create({ url: STUFLO_DASHBOARD_URL }));
openPrivacyButton.addEventListener('click', () => chrome.tabs.create({ url: STUFLO_PRIVACY_URL }));
init();
