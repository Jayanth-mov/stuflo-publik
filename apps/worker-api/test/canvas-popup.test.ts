import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const popup = readFileSync(new URL('../../../extensions/canvas-connector/popup.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../../extensions/canvas-connector/popup.html', import.meta.url), 'utf8');
type Tab = { id: number; url: string; incognito?: boolean };
type Callback = (value: any) => void;

// Drive callback ordering explicitly, without waiting on real browser timers.
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fixture() {
  const elements = Object.fromEntries(['connect', 'grant-permission', 'open-stuflo', 'open-privacy', 'status', 'host'].map((id) => {
    const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] || '';
    return [id, { disabled: /\bdisabled\b/.test(tag), textContent: '', className: '', click: () => undefined as unknown,
      addEventListener(_event: string, listener: () => unknown) { this.click = listener; } }];
  }));
  const tab: Tab = { id: 7, url: 'https://school.instructure.com/dashboard', incognito: false };
  const tabCallbacks: Callback[] = [];
  const permissionCallbacks: Callback[] = [];
  const requestCallbacks: Callback[] = [];
  const messageCallbacks: Callback[] = [];
  const chrome = {
    tabs: { query: vi.fn((_details, callback: Callback) => tabCallbacks.push(callback)), create: vi.fn() },
    permissions: { contains: vi.fn((_details, callback: Callback) => permissionCallbacks.push(callback)),
      request: vi.fn((_details, callback: Callback) => requestCallbacks.push(callback)) },
    runtime: { lastError: null as { message: string } | null,
      sendMessage: vi.fn((_message, callback: Callback) => messageCallbacks.push(callback)) },
  };
  const context = createContext({ document: { getElementById: (id: string) => elements[id] }, chrome, URL, Promise });
  runInContext(popup, context);
  const respond = async (callbacks: Callback[], value: unknown) => {
    const callback = callbacks.shift();
    expect(callback).toBeTypeOf('function');
    callback!(value); await settle();
  };
  const initialize = async (permission = false, activeTab = tab) => {
    await respond(tabCallbacks, [activeTab]);
    if (!activeTab.incognito) await respond(permissionCallbacks, permission);
  };
  return { elements, tab, chrome, tabCallbacks, permissionCallbacks, requestCallbacks, messageCallbacks,
    run: (expression: string) => runInContext(expression, context), respond, initialize };
}

const savedConnection = { ok: true, status: 200, cookieCount: 3,
  data: { validation: { data: { connected: true } }, connection: { canvasHost: 'school.instructure.com', status: 'connected' } } };

describe('Canvas connector popup', () => {
  it.each([
    { url: 'https://learn.university.edu/courses/42', origin: 'https://learn.university.edu/*' },
    { url: 'https://courses.college.ac.uk/dashboard', origin: 'https://courses.college.ac.uk/*' },
    { url: 'https://bücher.university.edu/courses', origin: 'https://xn--bcher-kva.university.edu/*' },
    { url: 'https://LEARN.University.edu:443/dashboard', origin: 'https://learn.university.edu/*' },
    { url: 'https://localhost.university.edu/dashboard', origin: 'https://localhost.university.edu/*' },
  ])('allows explicit permission on a public custom Canvas site: $url', async ({ url, origin }) => {
    const f = fixture();
    await f.respond(f.tabCallbacks, [{ ...f.tab, url }]);
    expect(f.chrome.permissions.contains).toHaveBeenCalledWith({ origins: [origin] }, expect.any(Function));
    await f.respond(f.permissionCallbacks, false);
    expect(f.elements['grant-permission'].disabled).toBe(false);
    expect(f.elements.connect.disabled).toBe(true);
    expect(f.chrome.permissions.request).not.toHaveBeenCalled();
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.elements.status.textContent).toMatch(/signed-in Canvas page/);
  });

  it('requests only the selected custom origin and connects after explicit permission', async () => {
    const f = fixture();
    const customTab = { ...f.tab, url: 'https://learn.university.edu/courses/42' };
    await f.initialize(false, customTab);
    const grant = f.elements['grant-permission'].click();
    await f.respond(f.tabCallbacks, [customTab]);
    await f.respond(f.permissionCallbacks, false);
    expect(f.chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://learn.university.edu/*'] }, expect.any(Function));
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    await f.respond(f.requestCallbacks, true); await grant;
    expect(f.elements.connect.disabled).toBe(false);
    const connect = f.elements.connect.click();
    await f.respond(f.tabCallbacks, [customTab]);
    await f.respond(f.permissionCallbacks, true);
    expect(f.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'STUFLO_CONNECT_CANVAS_REQUEST', canvasHost: 'learn.university.edu' }, expect.any(Function));
    await f.respond(f.messageCallbacks, { ...savedConnection,
      data: { ...savedConnection.data, connection: { canvasHost: 'learn.university.edu', status: 'connected' } } });
    await connect;
    expect(f.elements.status.textContent).toBe('Connected learn.university.edu with 3 cookies.');
  });

  it('does not connect an unapproved custom site when Connect is invoked directly', async () => {
    const f = fixture(); const customTab = { ...f.tab, url: 'https://learn.university.edu/' };
    await f.initialize(false, customTab);
    const connect = f.elements.connect.click();
    await f.respond(f.tabCallbacks, [customTab]); await f.respond(f.permissionCallbacks, false); await connect;
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.elements.status.textContent).toMatch(/Grant Canvas permission first/);
  });

  it('does not claim a generic public HTTPS site is detected Canvas and surfaces validation rejection', async () => {
    const f = fixture(); const genericTab = { ...f.tab, url: 'https://portal.university.edu/news' };
    await f.initialize(true, genericTab);
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.elements.status.textContent).toMatch(/Connect only from your signed-in Canvas page/);
    expect(html).toContain("StuFlo receives this site's cookies to validate and save your Canvas session.");
    const connect = f.elements.connect.click();
    await f.respond(f.tabCallbacks, [genericTab]); await f.respond(f.permissionCallbacks, true);
    await f.respond(f.messageCallbacks, { ok: false, status: 400, data: { error: 'Canvas did not return a valid signed-in profile.' } });
    await connect;
    expect(f.elements.status.textContent).toBe('Canvas did not return a valid signed-in profile.');
    expect(f.elements.status.className).toBe('status error');
  });

  it.each([
    'http://learn.university.edu/dashboard',
    'file:///canvas/dashboard',
    'chrome://extensions/',
    'https://user:password@canvas.university.edu/dashboard',
    'https://canvas.university.edu:8443/dashboard',
    'https://canvas.localhost/',
    'https://canvas.local/',
    'https://canvas.internal/',
    'https://canvas.test/',
    'https://canvas.invalid/',
    'https://canvas.example/',
    'https://canvas.home.arpa/',
    'https://canvas.onion/',
    'https://canvas.lan/',
    'https://canvas.home/',
    'https://canvas.corp/',
    'https://canvas/',
    'https://canvas.university.edu./',
    'https://canvas..university.edu/',
    'https://canvas_lms.university.edu/',
    'https://-canvas.university.edu/',
    'https://canvas.university.edu-/',
    `https://${'a'.repeat(64)}.university.edu/`,
    `https://${Array(4).fill('a'.repeat(63)).join('.')}/`,
    'https://127.0.0.1/',
    'https://127.1/',
    'https://0x7f000001/',
    'https://2130706433/',
    'https://10.1.2.3/',
    'https://100.64.0.1/',
    'https://203.0.113.10/',
    'https://[::1]/',
    'https://[fd00::1]/',
    'https://[2001:db8::1]/',
    'https://[::ffff:127.0.0.1]/',
  ])('rejects an unsupported active site before checking permission or connecting: %s', async (url) => {
    const f = fixture(); await f.respond(f.tabCallbacks, [{ ...f.tab, url }]);
    expect(f.elements['grant-permission'].disabled).toBe(true);
    expect(f.elements.connect.disabled).toBe(true);
    expect(f.elements.status.className).toBe('status error');
    expect(f.chrome.permissions.contains).not.toHaveBeenCalled();
    expect(f.chrome.permissions.request).not.toHaveBeenCalled();
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['grant', 'https://canvas.university.edu:8443/'],
    ['connect', 'https://user:password@canvas.university.edu/'],
    ['grant', 'https://canvas.local/'],
    ['connect', 'https://127.1/'],
  ])('rechecks an unsupported tab selected after initialization during %s: %s', async (action, url) => {
    const f = fixture(); await f.initialize(action === 'connect');
    const pending = f.elements[action === 'grant' ? 'grant-permission' : 'connect'].click();
    await f.respond(f.tabCallbacks, [{ ...f.tab, url }]); await pending;
    expect(f.chrome.permissions.contains).toHaveBeenCalledTimes(1);
    expect(f.chrome.permissions.request).not.toHaveBeenCalled();
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.elements['grant-permission'].disabled).toBe(true);
    expect(f.elements.connect.disabled).toBe(true);
  });

  it('keeps both actions disabled until initial tab and permission checks finish', async () => {
    const f = fixture();
    expect(f.elements['grant-permission'].disabled).toBe(true);
    expect(f.elements.connect.disabled).toBe(true);
    await f.elements['grant-permission'].click();
    await f.elements.connect.click();
    expect(f.chrome.tabs.query).toHaveBeenCalledTimes(1);
    await f.respond(f.tabCallbacks, [f.tab]);
    expect(f.elements['grant-permission'].disabled).toBe(true);
    await f.respond(f.permissionCallbacks, false);
    expect(f.elements['grant-permission'].disabled).toBe(false);
    expect(f.elements.connect.disabled).toBe(true);
  });

  it.each(['grant', 'connect'])('does not let superseded initialization overwrite a completed %s', async (action) => {
    const f = fixture();
    await f.respond(f.tabCallbacks, [f.tab]);
    const stalePermission = f.permissionCallbacks.shift()!;
    // A newer initialization completes while the first Chrome callback is delayed.
    const newerInit = f.run('init()');
    await f.initialize(action === 'connect');
    await newerInit;
    const pending = f.elements[action === 'grant' ? 'grant-permission' : 'connect'].click();
    await f.respond(f.tabCallbacks, [f.tab]);
    await f.respond(f.permissionCallbacks, action === 'connect');
    if (action === 'grant') await f.respond(f.requestCallbacks, true);
    else await f.respond(f.messageCallbacks, savedConnection);
    await pending;
    const completedStatus = f.elements.status.textContent;
    expect(completedStatus).toMatch(action === 'grant' ? /Permission granted/ : /Connected school\.instructure\.com with 3 cookies/);
    stalePermission(false); await settle();
    expect(f.elements.status.textContent).toBe(completedStatus);
    expect(f.elements.connect.disabled).toBe(false);
    expect(f.elements['grant-permission'].disabled).toBe(true);
  });

  it('does not re-enable Grant when stale initialization finishes during a permission request', async () => {
    const f = fixture();
    await f.respond(f.tabCallbacks, [f.tab]);
    const stalePermission = f.permissionCallbacks.shift()!;
    const newerInit = f.run('init()');
    await f.initialize(); await newerInit;
    const grant = f.elements['grant-permission'].click();
    await f.respond(f.tabCallbacks, [f.tab]);
    await f.respond(f.permissionCallbacks, false);
    const requestingStatus = f.elements.status.textContent;
    stalePermission(false); await settle();
    expect(f.elements.status.textContent).toBe(requestingStatus);
    expect(f.elements['grant-permission'].disabled).toBe(true);
    expect(f.elements.connect.disabled).toBe(true);
    const queryCount = f.chrome.tabs.query.mock.calls.length;
    await f.elements['grant-permission'].click();
    await f.elements.connect.click();
    expect(f.chrome.tabs.query).toHaveBeenCalledTimes(queryCount);
    expect(f.chrome.permissions.request).toHaveBeenCalledTimes(1);
    await f.respond(f.requestCallbacks, true); await grant;
    expect(f.elements.connect.disabled).toBe(false);
  });

  it('keeps Grant and repeated Connect from starting another operation during a connection', async () => {
    const f = fixture(); await f.initialize(true);
    const connect = f.elements.connect.click();
    const queryCount = f.chrome.tabs.query.mock.calls.length;
    expect(f.elements['grant-permission'].disabled).toBe(true);
    expect(f.elements.connect.disabled).toBe(true);
    await f.elements['grant-permission'].click(); await f.elements.connect.click();
    await f.run('init()');
    expect(f.chrome.tabs.query).toHaveBeenCalledTimes(queryCount);
    await f.respond(f.tabCallbacks, [f.tab]);
    await f.respond(f.permissionCallbacks, true);
    await f.respond(f.messageCallbacks, savedConnection); await connect;
    expect(f.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.elements.status.textContent).toBe('Connected school.instructure.com with 3 cookies.');
    expect(f.elements.connect.disabled).toBe(false);
  });

  it('rejects incognito initialization before querying permission', async () => {
    const f = fixture(); await f.initialize(false, { ...f.tab, incognito: true });
    expect(f.elements.status.textContent).toMatch(/normal browser window/i);
    expect(f.elements['grant-permission'].disabled).toBe(true);
    expect(f.elements.connect.disabled).toBe(true);
    expect(f.chrome.permissions.contains).not.toHaveBeenCalled();
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['grant', 'connect'])('rejects an incognito active tab during %s before requesting or sending cookies', async (action) => {
    const f = fixture(); await f.initialize(action === 'connect');
    const pending = f.elements[action === 'grant' ? 'grant-permission' : 'connect'].click();
    await f.respond(f.tabCallbacks, [{ ...f.tab, incognito: true }]); await pending;
    expect(f.elements.status.textContent).toMatch(/normal browser window/i);
    expect(f.chrome.permissions.contains).toHaveBeenCalledTimes(1);
    expect(f.chrome.permissions.request).not.toHaveBeenCalled();
    expect(f.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'session_expired', error: 'Canvas session expired.' },
    { code: 'not_connected', error: 'Canvas is not connected.' },
    { errorCode: 'permission_denied' },
    { error: 'session_expired' },
    { status: 'not_logged_in' },
  ])('directs Canvas 401 failures to Canvas sign-in: %j', (data) => {
    const f = fixture();
    const message = f.run(`describeFailure(${JSON.stringify({ ok: false, status: 401, data })})`);
    expect(message).toMatch(/Canvas did not accept this session/);
  });

  it('directs a StuFlo unauthorized 401 to StuFlo sign-in', () => {
    const f = fixture();
    expect(f.run("describeFailure({ ok: false, status: 401, data: { error: 'unauthorized' } })")).toMatch(/StuFlo is not signed in/);
  });

  it('shows a Chrome transport error and restores Connect for a retry', async () => {
    const f = fixture(); await f.initialize(true);
    const connect = f.elements.connect.click();
    await f.respond(f.tabCallbacks, [f.tab]); await f.respond(f.permissionCallbacks, true);
    f.chrome.runtime.lastError = { message: 'The message port closed before a response was received.' };
    await f.respond(f.messageCallbacks, undefined); f.chrome.runtime.lastError = null;
    await connect;
    expect(f.elements.status.textContent).toMatch(/message port closed/);
    expect(f.elements.connect.disabled).toBe(false);
  });
});
