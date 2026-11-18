// Chrome can reinject this file when a tab has no active receiver. Register only once.
if (!globalThis.__stufloCanvasConnectorInstalled) {
globalThis.__stufloCanvasConnectorInstalled = true;
const allowedRefreshReasons = new Set(['manual', 'cookie', 'canvas-tab', 'stuflo-tab', 'alarm', 'startup']);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'STUFLO_CONNECT_CANVAS') return false;
  if (sender.id !== chrome.runtime.id) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60 * 1000);
  const headers = { 'Content-Type': 'application/json' };
  if (allowedRefreshReasons.has(message.refreshReason)) {
    headers['X-StuFlo-Canvas-Refresh-Reason'] = message.refreshReason;
  }
  fetch('/api/canvas/extension/connect', {
    method: 'POST',
    credentials: 'include',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      canvasUrl: message.canvasUrl,
      cookies: message.cookies,
    }),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      const acknowledged = data?.validation?.data?.connected === true &&
        data?.connection?.canvasHost === message.canvasUrl &&
        (data.connection.status === 'connected' || data.connection.connected === true);
      sendResponse({ ok: response.ok && acknowledged, status: response.status, data,
        ...(response.ok && !acknowledged ? { error: 'StuFlo did not confirm a saved Canvas connection. Keep StuFlo signed in and try again.' } : {}) });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: controller.signal.aborted
        ? 'Canvas connection timed out. Keep StuFlo open and signed in, then try again.' : error?.message || String(error) });
    })
    .finally(() => clearTimeout(timeout));

  return true;
});
}
