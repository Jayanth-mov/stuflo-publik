import { describe, expect, it, vi } from 'vitest';
import { CanvasError, CanvasHttpClient, parseNextLink, stripCanvasPrefix } from '../src';

const connection = {
  canvasHost: 'school.instructure.com',
  cookies: [{ name: 'canvas_session', value: 'secret', domain: '.instructure.com', path: '/' }],
};

describe('Canvas HTTP client', () => {
  it('does not download a Canvas login page as an authenticated course file', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/login/saml' } }));
    const client = new CanvasHttpClient(connection, { fetch: fetcher });
    await expect(client.getBinary('https://school.instructure.com/files/88/download', { maxBytes: 1024 })).rejects.toMatchObject({ code: 'session_expired' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends only path-compatible cookies to an authenticated file download', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('file'));
    const client = new CanvasHttpClient({ ...connection, cookies: [...connection.cookies, { name: 'api_only', value: 'private', domain: 'school.instructure.com', path: '/api/v1' }] }, { fetch: fetcher });
    await client.getBinary('https://school.instructure.com/files/88/download', { maxBytes: 1024 });
    expect(fetcher.mock.calls[0][1].headers.cookie).toBe('canvas_session=secret');
  });

  it('strips the Canvas anti-hijacking prefix', () => {
    expect(stripCanvasPrefix('while(1);[{"id":1}]')).toBe('[{"id":1}]');
  });

  it('parses the next pagination link', () => {
    expect(
      parseNextLink(
        '<https://school.instructure.com/api/v1/courses?page=2>; rel="next", <https://school.instructure.com/api/v1/courses?page=4>; rel="last"',
      ),
    ).toContain('page=2');
  });

  it('follows same-host pagination and combines arrays', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('[{"id":1}]', {
          headers: {
            link: '<https://school.instructure.com/api/v1/courses?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('while(1);[{"id":2}]'));
    const client = new CanvasHttpClient(connection, { fetch: fetcher });
    const result = await client.getJson<Array<{ id: number }>>('/api/v1/courses', {
      paginate: true,
    });
    expect(result.data.map((item) => item.id)).toEqual([1, 2]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].headers.cookie).toBe('canvas_session=secret');
  });

  it('rejects cross-origin pagination', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('[]', {
        headers: { link: '<https://evil.example/api/v1/courses?page=2>; rel="next"' },
      }),
    );
    const client = new CanvasHttpClient(connection, { fetch: fetcher });
    await expect(client.getJson('/api/v1/courses', { paginate: true })).rejects.toMatchObject({
      code: 'invalid_connection',
    });
  });

  it('maps redirects to a reconnect error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 302 }));
    const client = new CanvasHttpClient(connection, { fetch: fetcher, sessionRetryDelaysMs: [] });
    await expect(client.getJson('/api/v1/users/self/profile')).rejects.toEqual(
      expect.objectContaining<Partial<CanvasError>>({ code: 'session_expired', status: 302 }),
    );
  });

  it('retries a transient session-like response before declaring the session expired', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 302 }))
      .mockResolvedValueOnce(Response.json({ id: 7, name: 'Student' }));
    const client = new CanvasHttpClient(connection, { fetch: fetcher, sessionRetryDelaysMs: [0] });
    await expect(client.getJson('/api/v1/users/self/profile')).resolves.toMatchObject({
      data: { id: 7, name: 'Student' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not bind the runtime fetch function to the HTTP client', async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      return Promise.resolve(Response.json({ id: 7 }));
    });
    vi.stubGlobal('fetch', runtimeFetch);
    try {
      const client = new CanvasHttpClient(connection);
      await expect(client.getJson('/api/v1/users/self/profile')).resolves.toMatchObject({
        data: { id: 7 },
      });
      expect(runtimeFetch.mock.contexts[0]).not.toBe(client);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never forwards Canvas cookies while following a public external download', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://school.instructure.com/files/88/download' },
        }),
      )
      .mockResolvedValueOnce(new Response('public resource', { headers: { 'content-type': 'text/plain' } }));
    const client = new CanvasHttpClient(connection, { fetch: fetcher });
    await expect(
      client.getBinary('https://public.example/syllabus.txt', {
        maxBytes: 1_024,
        allowExternalInitial: true,
      }),
    ).resolves.toMatchObject({ contentType: 'text/plain' });
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('cookie');
    expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('cookie');
  });
});
