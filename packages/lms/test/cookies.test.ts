import { describe, expect, it } from 'vitest';
import {
  buildCanvasCookieHeader,
  cookieMatchesHost,
  normalizeCanvasHost,
  type CanvasCookie,
} from '../src';

describe('Canvas cookie boundaries', () => {
  it('accepts existing browser cookies containing spaces, quotes, commas, and JSON analytics', () => {
    const cookies: CanvasCookie[] = [
      { name: 'canvas_session', value: 'valid_session', domain: 'school.instructure.com' },
      { name: '__utmzz', value: 'utmcsr=direct traffic', domain: '.instructure.com' },
      { name: '_hp2_id.3001039959', value: '{"userId":"fixture","sessionId":"fixture"}', domain: '.instructure.com' },
    ];
    expect(buildCanvasCookieHeader(cookies, 'school.instructure.com')).toContain('__utmzz=utmcsr=direct traffic');
  });

  it.each(['first\r\nInjected: yes', 'first\tsecond', 'first\u0000second', 'first; injected=second'])('still rejects cookie header delimiters and controls', (value) => {
    expect(() => buildCanvasCookieHeader([{ name: 'canvas_session', value, domain: 'school.instructure.com' }], 'school.instructure.com')).toThrow(/cookie/i);
  });

  it('rejects loopback and private IPv6 hosts without rejecting ordinary hostnames', () => {
    expect(() => normalizeCanvasHost('https://[::1]')).toThrow(/public HTTPS/);
    expect(() => normalizeCanvasHost('https://[fd00::1]')).toThrow(/public HTTPS/);
    expect(normalizeCanvasHost('fcu.instructure.com')).toBe('fcu.instructure.com');
  });

  it('respects host-only cookies and sorts duplicate names by path specificity', () => {
    expect(cookieMatchesHost({ name: 'session', value: 'private', domain: 'instructure.com', hostOnly: true }, 'school.instructure.com')).toBe(false);
    const cookies: CanvasCookie[] = [
      { name: 'session', value: 'root', domain: '.instructure.com', path: '/' },
      { name: 'session', value: 'api', domain: 'school.instructure.com', path: '/api/v1' },
    ];
    expect(buildCanvasCookieHeader(cookies, 'school.instructure.com', '/api/v1/courses')).toBe('session=api; session=root');
  });

  it('rejects malformed cookie values before a fetch can expose them in headers', () => {
    expect(() => buildCanvasCookieHeader([{ name: 'session', value: 'one; injected=two', domain: 'school.instructure.com' }], 'school.instructure.com')).toThrow(/cookie/i);
  });

  it('normalizes public HTTPS hosts', () => {
    expect(normalizeCanvasHost('https://Canvas.TAMU.edu/')).toBe('canvas.tamu.edu');
    expect(normalizeCanvasHost('utexas.instructure.com')).toBe('utexas.instructure.com');
  });

  it('rejects local and insecure hosts', () => {
    expect(() => normalizeCanvasHost('http://canvas.example.edu')).toThrow(/public HTTPS/);
    expect(() => normalizeCanvasHost('https://127.0.0.1')).toThrow(/public HTTPS/);
    expect(() => normalizeCanvasHost('https://canvas.local')).toThrow(/public HTTPS/);
  });

  it('only sends parent-domain or exact-host cookies', () => {
    const exact = { name: 'canvas_session', value: 'one', domain: 'canvas.tamu.edu' };
    const parent = { name: 'shared', value: 'two', domain: '.tamu.edu' };
    const child = { name: 'wrong', value: 'three', domain: 'evil.canvas.tamu.edu' };
    expect(cookieMatchesHost(exact, 'canvas.tamu.edu')).toBe(true);
    expect(cookieMatchesHost(parent, 'canvas.tamu.edu')).toBe(true);
    expect(cookieMatchesHost(child, 'canvas.tamu.edu')).toBe(false);
  });

  it('filters unrelated, expired, and path-incompatible cookies', () => {
    const cookies: CanvasCookie[] = [
      { name: 'canvas_session', value: 'ok', domain: '.instructure.com', path: '/' },
      { name: 'other', value: 'no', domain: 'example.com', path: '/' },
      { name: 'expired', value: 'no', domain: 'utexas.instructure.com', expires: 1 },
      { name: 'account', value: 'no', domain: 'utexas.instructure.com', path: '/account' },
    ];
    expect(buildCanvasCookieHeader(cookies, 'utexas.instructure.com', '/api/v1/courses', 10)).toBe(
      'canvas_session=ok',
    );
  });
});
