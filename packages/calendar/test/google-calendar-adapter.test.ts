import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarAdapter } from '../src';

const validTokens = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function connection(overrides = {}) {
  return {
    tokens: validTokens,
    oauth: { clientId: 'client-id', clientSecret: 'client-secret' },
    ...overrides,
  };
}

describe('GoogleCalendarAdapter', () => {
  it('rejects repeated pagination tokens before looping through ten duplicate pages', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [{ id: 'one', accessRole: 'owner' }], nextPageToken: 'repeat' }));
    await expect(new GoogleCalendarAdapter(connection(), { fetch: fetcher }).listCalendars()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not let duplicate page entries consume the event result bound', async () => {
    const event = { start: { date: '2026-10-02' }, end: { date: '2026-10-03' } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: 'one', accessRole: 'owner' }] }))
      .mockResolvedValueOnce(Response.json({ items: [{ ...event, id: '1' }, { ...event, id: '1' }], nextPageToken: 'second' }))
      .mockResolvedValueOnce(Response.json({ items: [{ ...event, id: '2' }] }));
    const result = await new GoogleCalendarAdapter(connection(), { fetch: fetcher }).listEvents({
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z', maxResultsPerCalendar: 2,
    });
    expect(result.map((item) => item.id)).toEqual(['1', '2']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds simultaneous calendar event requests', async () => {
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/calendarList')) return Response.json({ items: Array.from({ length: 15 }, (_, i) => ({ id: `cal-${i}`, accessRole: 'reader' })) });
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return Response.json({ items: [] });
    });
    await new GoogleCalendarAdapter(connection(), { fetch: fetcher }).listEvents({ timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z' });
    expect(peak).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(16);
  });

  it('shares a single token refresh across concurrent calendar requests', async () => {
    const save = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/token')) {
        await Promise.resolve();
        return Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3_600 });
      }
      return Response.json({ items: [] });
    });
    const adapter = new GoogleCalendarAdapter(connection({
      tokens: { ...validTokens, expiresAt: '2020-01-01T00:00:00Z' }, onTokensUpdated: save,
    }), { fetch: fetcher });
    await Promise.all([adapter.listCalendars(), adapter.listCalendars(), adapter.listCalendars()]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'rotated' }));
  });

  it('refreshes malformed expiry metadata instead of sending a stale token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 3_600 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const adapter = new GoogleCalendarAdapter(connection({ tokens: { ...validTokens, expiresAt: 'not-a-date' } }), { fetch: fetcher });
    await adapter.listCalendars();
    expect(fetcher.mock.calls[0][0]).toContain('/token');
  });

  it.each(['invalid_client', 'invalid_request', 'temporarily_unavailable'])('does not disconnect for OAuth %s failures', async (error) => {
    const expired = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error }, { status: 400 }));
    const adapter = new GoogleCalendarAdapter(connection({
      tokens: { ...validTokens, expiresAt: null }, onAuthorizationExpired: expired,
    }), { fetch: fetcher });
    await expect(adapter.listCalendars()).rejects.toMatchObject({ code: 'upstream_error' });
    expect(expired).not.toHaveBeenCalled();
  });

  it('marks invalid_grant authorization as expired exactly once', async () => {
    const expired = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const adapter = new GoogleCalendarAdapter(connection({
      tokens: { ...validTokens, expiresAt: null }, onAuthorizationExpired: expired,
    }), { fetch: fetcher });
    await expect(adapter.listCalendars()).rejects.toMatchObject({ code: 'session_expired' });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recovers a transient token refresh outage without expiring the account', async () => {
    const expired = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 3_600 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const adapter = new GoogleCalendarAdapter(connection({
      tokens: { ...validTokens, expiresAt: null }, onAuthorizationExpired: expired,
    }), { fetch: fetcher });
    await expect(adapter.listCalendars()).resolves.toEqual([]);
    expect(expired).not.toHaveBeenCalled();
  });

  it('normalizes persistent token-refresh network failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Network disconnected'));
    const adapter = new GoogleCalendarAdapter(connection({ tokens: { ...validTokens, expiresAt: null } }), { fetch: fetcher });
    await expect(adapter.listCalendars()).rejects.toMatchObject({ code: 'upstream_error' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries unauthorized reads with a fresh token and expires only a persistently unauthorized grant', async () => {
    const expired = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 3_600 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const adapter = new GoogleCalendarAdapter(connection({ onAuthorizationExpired: expired }), { fetch: fetcher });
    await expect(adapter.listCalendars()).rejects.toMatchObject({ code: 'session_expired' });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries a transient read but does not retry an event write after an ambiguous server failure', async () => {
    const read = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    await expect(new GoogleCalendarAdapter(connection(), { fetch: read }).listCalendars()).resolves.toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    const write = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(new GoogleCalendarAdapter(connection(), { fetch: write }).createEvent('primary', {
      summary: 'Study', start: { date: '2026-10-02' }, end: { date: '2026-10-03' },
    })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('follows calendar and event pages, skipping malformed and cancelled events', async () => {
    const event = { id: 'event', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: 'one', accessRole: 'owner' }], nextPageToken: 'cal-page2' }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'busy', accessRole: 'freeBusyReader' }] }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'bad' }, { ...event, status: 'cancelled' }], nextPageToken: 'events-page2' }))
      .mockResolvedValueOnce(Response.json({ items: [event] }));
    const result = await new GoogleCalendarAdapter(connection(), { fetch: fetcher }).listEvents({
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z',
    });
    expect(result).toHaveLength(1);
    expect(result[0].end.date).toBe('2026-10-03');
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=cal-page2');
    expect(fetcher.mock.calls[3][0]).toContain('pageToken=events-page2');
    expect(fetcher.mock.calls.some(([url]) => url.includes('/calendars/busy/events'))).toBe(false);
  });

  it('sorts offset timestamps by their actual instant and all-day events by calendar midnight', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: 'one', accessRole: 'owner', timeZone: 'America/Chicago' }] }))
      .mockResolvedValueOnce(Response.json({ items: [
        { id: 'later', start: { dateTime: '2026-10-02T08:00:00-07:00' }, end: { dateTime: '2026-10-02T09:00:00-07:00' } },
        { id: 'earlier', start: { dateTime: '2026-10-02T09:00:00-05:00' }, end: { dateTime: '2026-10-02T10:00:00-05:00' } },
        { id: 'all-day', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
        { id: 'previous-evening', start: { dateTime: '2026-10-02T03:00:00Z' }, end: { dateTime: '2026-10-02T04:00:00Z' } },
      ] }));
    const result = await new GoogleCalendarAdapter(connection(), { fetch: fetcher }).listEvents({
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z',
    });
    expect(result.map((event) => event.id)).toEqual(['previous-evening', 'all-day', 'earlier', 'later']);
    expect(result[1].start).toEqual({ date: '2026-10-02', timeZone: 'America/Chicago' });
  });

  it('stops at the requested per-calendar bound even when Google returns more pages', async () => {
    const event = { start: { date: '2026-10-02' }, end: { date: '2026-10-03' } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: 'one', accessRole: 'owner' }] }))
      .mockResolvedValueOnce(Response.json({ items: [{ ...event, id: '1' }, { ...event, id: '2' }, { ...event, id: '3' }], nextPageToken: 'extra' }));
    const result = await new GoogleCalendarAdapter(connection(), { fetch: fetcher }).listEvents({
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z', maxResultsPerCalendar: 2,
    });
    expect(result).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid time windows without making network calls', async () => {
    const fetcher = vi.fn();
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });
    for (const window of [
      { timeMin: '2026-10-01', timeMax: '2026-11-01' },
      { timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-10-01T00:00:00Z' },
      { timeMin: '2026-10-01T10:00:00', timeMax: '2026-10-02T10:00:00' },
    ]) await expect(adapter.listEvents(window)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts canonical UTC times and cleared optional fields when verifying an update', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'event-1' }))
      .mockResolvedValueOnce(Response.json({ id: 'event-1', start: { dateTime: '2026-10-02T15:00:00Z' }, end: { dateTime: '2026-10-02T16:00:00Z' } }));
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });
    await expect(adapter.updateEvent('primary', 'event-1', {
      description: '', location: '', start: { dateTime: '2026-10-02T10:00:00-05:00', timeZone: 'America/Chicago' },
    })).resolves.toMatchObject({ description: null, location: null });
  });

  it('lists normalized calendars and marks writable roles', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          { id: 'primary@example.com', summary: 'Primary', primary: true, accessRole: 'owner' },
          { id: 'school@example.com', summary: 'School', accessRole: 'reader' },
        ],
      }),
    );
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });
    await expect(adapter.listCalendars()).resolves.toEqual([
      expect.objectContaining({ id: 'primary@example.com', writable: true }),
      expect.objectContaining({ id: 'school@example.com', writable: false }),
    ]);
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe('Bearer access-token');
  });

  it('resolves the primary calendar and writable display names to exact IDs', async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({
        items: [
          { id: 'jayanth@example.com', summary: 'Jayanth', primary: true, accessRole: 'owner' },
          { id: 'readonly@example.com', summary: 'Read only', accessRole: 'reader' },
        ],
      })),
    );
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });

    await expect(adapter.resolveCalendar()).resolves.toMatchObject({ id: 'jayanth@example.com' });
    await expect(adapter.resolveCalendar('jAyAnTh')).resolves.toMatchObject({
      id: 'jayanth@example.com',
    });
    await expect(adapter.resolveCalendar('Read only')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refreshes an expired access token and persists the update', async () => {
    const onTokensUpdated = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh-token', expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const adapter = new GoogleCalendarAdapter(
      connection({
        tokens: { ...validTokens, accessToken: '', expiresAt: '2020-01-01T00:00:00.000Z' },
        onTokensUpdated,
      }),
      { fetch: fetcher },
    );
    await adapter.listCalendars();
    expect(fetcher.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-token');
    expect(onTokensUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh-token', refreshToken: 'refresh-token' }),
    );
  });

  it('creates and verifies events with full details and custom reminders', async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({
        id: 'event-1',
        summary: 'Study block',
        description: 'Meet: https://meet.google.com/example',
        start: { dateTime: '2026-08-07T10:00:00-05:00' },
        end: { dateTime: '2026-08-07T11:00:00-05:00' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 120 },
          ],
        },
      })),
    );
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });
    const event = await adapter.createEvent('primary@example.com', {
      summary: 'Study block',
      description: 'Meet: https://meet.google.com/example',
      start: { dateTime: '2026-08-07T10:00:00-05:00' },
      end: { dateTime: '2026-08-07T11:00:00-05:00' },
      reminderMinutesBefore: [60, 120],
      stufloId: 'assignment-123',
    });
    expect(event.id).toBe('event-1');
    expect(fetcher.mock.calls[0][0]).toContain('sendUpdates=none');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      description: 'Meet: https://meet.google.com/example',
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 120 },
        ],
      },
      extendedProperties: { private: { stufloId: 'assignment-123' } },
    });
    expect(fetcher.mock.calls[1][0]).toContain('/events/event-1');
    expect(event.description).toContain('meet.google.com');
    expect(event.reminders?.overrides).toHaveLength(2);
  });

  it('rejects an update when Google does not persist the requested details', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'event-1' }))
      .mockResolvedValueOnce(
        Response.json({
          id: 'event-1',
          summary: 'Study block',
          start: { dateTime: '2026-08-07T10:00:00-05:00' },
          end: { dateTime: '2026-08-07T11:00:00-05:00' },
        }),
      );
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });

    await expect(
      adapter.updateEvent('primary@example.com', 'event-1', { description: 'Dial-in details' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('uses one provider event ID after an insert succeeds but verification initially fails', async () => {
    const input = { summary: 'Study block', start: { dateTime: '2026-08-07T10:00:00-05:00' },
      end: { dateTime: '2026-08-07T11:00:00-05:00' }, idempotencyKey: 'server-turn-42|primary|study-block' };
    const rows = new Map<string, Record<string, unknown>>();
    let readUnavailable = true;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (rows.has(body.id)) return Response.json({ error: { message: 'Duplicate ID' } }, { status: 409 });
        rows.set(body.id, body);
        return Response.json(body);
      }
      if (readUnavailable) return Response.json({ error: { message: 'Read unavailable' } }, { status: 503 });
      return Response.json([...rows.values()][0]);
    });
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: fetcher });
    await expect(adapter.createEvent('primary', input)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(rows.size).toBe(1);
    readUnavailable = false;
    const event = await adapter.createEvent('primary', input);
    expect(rows.size).toBe(1);
    expect(event.summary).toBe(input.summary);
    const ids = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)).id);
    expect(ids[0]).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('recovers an ambiguous lost insert response by verifying the deterministic ID without another write', async () => {
    let persisted: Record<string, unknown>;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        persisted = JSON.parse(String(init.body));
        throw new Error('Response lost after insert');
      }
      return Response.json(persisted!);
    });
    const event = await new GoogleCalendarAdapter(connection(), { fetch: fetcher }).createEvent('primary', {
      summary: 'Study block', start: { date: '2026-08-07' }, end: { date: '2026-08-08' }, idempotencyKey: 'server-operation' });
    expect(event.summary).toBe('Study block');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls[1][0]).toContain(`/events/${event.id}`);
  });

  it('never accepts a conflicting event with different persisted fields as successful creation', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ error: { message: 'Duplicate ID' } }, { status: 409 })
      : Response.json({ id: 'existing', summary: 'Unrelated appointment', start: { date: '2026-08-07' }, end: { date: '2026-08-08' } }));
    await expect(new GoogleCalendarAdapter(connection(), { fetch: fetcher }).createEvent('primary', {
      summary: 'Study block', start: { date: '2026-08-07' }, end: { date: '2026-08-08' }, idempotencyKey: 'server-operation',
    })).rejects.toMatchObject({ code: 'invalid_response', message: 'Google Calendar did not persist the requested event title.' });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not treat a deleted event with a reused creation key as an active event', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ error: { message: 'Duplicate ID' } }, { status: 409 })
      : Response.json({ id: 'existing', status: 'cancelled', summary: 'Study block', start: { date: '2026-08-07' }, end: { date: '2026-08-08' } }));
    await expect(new GoogleCalendarAdapter(connection(), { fetch: fetcher }).createEvent('primary', {
      summary: 'Study block', start: { date: '2026-08-07' }, end: { date: '2026-08-08' }, idempotencyKey: 'server-operation',
    })).rejects.toMatchObject({ code: 'invalid_response', message: expect.stringContaining('deleted') });
  });

  it('does not expose a delete operation', () => {
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: vi.fn() });
    expect('deleteEvent' in adapter).toBe(false);
  });

  it('does not bind the runtime fetch function to the calendar adapter', async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      return Promise.resolve(Response.json({ items: [] }));
    });
    vi.stubGlobal('fetch', runtimeFetch);
    try {
      const adapter = new GoogleCalendarAdapter(connection());
      await expect(adapter.listCalendars()).resolves.toEqual([]);
      expect(runtimeFetch.mock.contexts[0]).not.toBe(adapter);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not bind an injected fetch function to the calendar adapter', async () => {
    const injectedFetch = vi.fn(function (this: unknown) {
      return Promise.resolve(Response.json({ items: [] }));
    });
    const adapter = new GoogleCalendarAdapter(connection(), { fetch: injectedFetch });

    await expect(adapter.listCalendars()).resolves.toEqual([]);
    expect(injectedFetch.mock.contexts[0]).not.toBe(adapter);
  });
});
