import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const content = readFileSync(new URL('../../../extensions/canvas-connector/content.js', import.meta.url), 'utf8');
const canvasHost = 'school.instructure.com';
const cookies = [{ name: '_normandy_session', value: 'synthetic', domain: canvasHost, path: '/' }];

function fixture() {
  const addListener = vi.fn();
  const sendResponse = vi.fn();
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({
    validation: { data: { connected: true } }, connection: { canvasHost, status: 'connected' },
  }));
  const context = createContext({ chrome: { runtime: { id: 'connector', onMessage: { addListener } } },
    fetch: fetcher, AbortController, setTimeout, clearTimeout, Promise, JSON, Set });
  runInContext(content, context);
  const listener = addListener.mock.calls[0][0];
  const connect = async (refreshReason?: unknown) => {
    expect(listener({ type: 'STUFLO_CONNECT_CANVAS', canvasUrl: canvasHost, cookies, refreshReason },
      { id: 'connector' }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
    return fetcher.mock.calls[0];
  };
  return { fetcher, sendResponse, listener, connect };
}

describe('Canvas content refresh reason header', () => {
  it.each(['manual', 'cookie', 'canvas-tab', 'stuflo-tab', 'alarm', 'startup'])('sends the allowed %s reason on the connector POST', async (reason) => {
    const f = fixture();
    const [url, init] = await f.connect(reason);
    expect(url).toBe('/api/canvas/extension/connect');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const headers = new Headers(init.headers);
    expect(headers.get('X-StuFlo-Canvas-Refresh-Reason')).toBe(reason);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ canvasUrl: canvasHost, cookies });
    expect(init.signal?.aborted).toBe(false);
    expect(f.sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: 200 }));
  });

  it.each([undefined, null, '', 'unrecognized', 'MANUAL', 'manual\r\nX-Injected: yes', {}, ['manual'], true])('omits an absent or invalid reason: %j', async (reason) => {
    const f = fixture();
    const [, init] = await f.connect(reason);
    const headers = new Headers(init.headers);
    expect(headers.has('X-StuFlo-Canvas-Refresh-Reason')).toBe(false);
    const headerNames: string[] = [];
    headers.forEach((_value, name) => headerNames.push(name));
    expect(headerNames).toEqual(['content-type']);
    expect(f.sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: 200 }));
  });

  it('rejects another extension sender before posting a valid reason', () => {
    const f = fixture();
    expect(f.listener({ type: 'STUFLO_CONNECT_CANVAS', canvasUrl: canvasHost, cookies, refreshReason: 'manual' },
      { id: 'other-extension' }, f.sendResponse)).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.sendResponse).not.toHaveBeenCalled();
  });
});
