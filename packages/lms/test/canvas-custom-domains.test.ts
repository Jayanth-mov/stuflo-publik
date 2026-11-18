import { describe, expect, it, vi } from 'vitest';
import { CanvasAdapter, CanvasHttpClient, normalizeCanvasHost } from '../src';

// These are synthetic transport fixtures, not signed-in university acceptance.
const domains = [
  ['school.instructure.com', 'school.instructure.com'],
  ['https://Canvas.Example.edu/', 'canvas.example.edu'],
  ['https://LMS.Example.edu/', 'lms.example.edu'],
  ['https://learn.campus.example.ac.uk/', 'learn.campus.example.ac.uk'],
  ['https://courses.example.edu/', 'courses.example.edu'],
  ['https://LMS.Bücher.edu/', 'lms.xn--bcher-kva.edu'],
] as const;

describe('Canvas custom-domain transport', () => {
  it.each(domains)('validates a session on its actual HTTPS host: %s', async (input, host) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 7, name: 'Fixture student' }));
    const adapter = new CanvasAdapter({
      canvasHost: input,
      cookies: [
        { name: '_normandy_session', value: 'fixture_session', domain: host, hostOnly: true, path: '/' },
        { name: 'other_school', value: 'must_not_send', domain: 'another-school.edu', path: '/' },
        { name: 'child_cookie', value: 'must_not_send', domain: `files.${host}`, path: '/' },
      ],
    }, { fetch: fetcher, sessionRetryDelaysMs: [] });

    const result = await adapter.validateSession();
    expect(result.data).toMatchObject({ connected: true, canvasHost: host, userId: '7' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://${host}/api/v1/users/self/profile`);
    expect(init).toMatchObject({
      redirect: 'manual',
      headers: { origin: `https://${host}`, referer: `https://${host}/`, cookie: '_normandy_session=fixture_session' },
    });
  });

  it('keeps custom-domain pagination on the connected origin', async () => {
    const host = 'lms.example.edu';
    const fetcher = vi.fn().mockResolvedValue(Response.json([], {
      headers: { link: '<https://login.example.edu/api/v1/courses?page=2>; rel="next"' },
    }));
    const client = new CanvasHttpClient({ canvasHost: host,
      cookies: [{ name: '_normandy_session', value: 'fixture_session', domain: host }] }, { fetch: fetcher });
    await expect(client.getJson('/api/v1/courses', { paginate: true })).rejects.toMatchObject({ code: 'invalid_connection' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not follow a custom-domain SSO redirect with session cookies', async () => {
    const host = 'lms.example.edu';
    const fetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://sso.example.edu/login' },
    }));
    const adapter = new CanvasAdapter({ canvasHost: host,
      cookies: [{ name: '_normandy_session', value: 'fixture_session', domain: host }] },
    { fetch: fetcher, sessionRetryDelaysMs: [] });
    expect((await adapter.validateSession()).data).toMatchObject({ connected: false, errorCode: 'session_expired' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`https://${host}/api/v1/users/self/profile`);
  });

  it('rejects an HTML login page on a custom domain', async () => {
    const host = 'lms.example.edu';
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>Sign in</html>', {
      headers: { 'content-type': 'text/html' },
    }));
    const adapter = new CanvasAdapter({ canvasHost: host,
      cookies: [{ name: '_normandy_session', value: 'fixture_session', domain: host }] }, { fetch: fetcher });
    await expect(adapter.validateSession()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    'http://lms.example.edu', 'https://lms.example.edu:8443', 'https://user:password@lms.example.edu',
    'https://localhost', 'https://lms.internal', 'https://10.0.0.1', 'https://[fd00::1]',
    'https://[::ffff:127.0.0.1]', 'https://2130706433', 'https://0x7f000001',
    'https://203.0.113.5', 'https://canvas', 'https://lms.test', 'https://lms.invalid',
    'https://lms.example', 'https://lms.home.arpa', 'https://under_score.example.edu',
    'https://-bad.example.edu', 'https://bad-.example.edu', 'https://lms..example.edu',
  ])('retains backend host safety boundaries: %s', (host) => {
    expect(() => normalizeCanvasHost(host)).toThrow(/public HTTPS/);
  });
});
