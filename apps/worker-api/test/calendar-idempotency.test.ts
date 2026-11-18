import { describe, expect, it, vi } from 'vitest';
import type { EventDateTime } from '@stuflo/calendar';
import { runStuTurn } from '../src/turn';
import type { ModelGateway } from '../src/model/model-gateway';

type EventSpec = { summary: string; start: EventDateTime; end: EventDateTime };
async function createInOneTurn(events: EventSpec[]) {
  const rows = new Map<string, Record<string, unknown>>();
  const complete = vi.fn();
  for (const [index, event] of events.entries()) complete.mockResolvedValueOnce({
    content: '', toolCalls: [{ id: `provider-call-${index}`, type: 'function', function: {
      name: 'calendar_create_event', arguments: JSON.stringify({ ...event, description: '', stufloId: `model-generated-${index}` }),
    } }], provider: 'openai', model: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
  });
  complete.mockResolvedValue({ content: 'Finished checking calendar operations.', toolCalls: [],
    provider: 'openai', model: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users/me/calendarList')) return Response.json({ items: [
      { id: 'primary', summary: 'Primary', primary: true, accessRole: 'owner' },
    ] });
    if (init?.method === 'POST') {
      const event = JSON.parse(String(init.body));
      if (rows.has(event.id)) return Response.json({ error: { message: 'Duplicate event ID' } }, { status: 409 });
      rows.set(event.id, event);
      return Response.json(event);
    }
    const row = rows.get(url.pathname.split('/').at(-1)!);
    return row ? Response.json(row) : Response.json({ error: { message: 'Not found' } }, { status: 404 });
  });
  const result = await runStuTurn({ complete } as ModelGateway, {
    messages: [{ role: 'user', content: 'Schedule the requested study blocks on my calendar.' }],
    calendarMutationKey: 'same-server-turn', calendarConnection: {
      tokens: { accessToken: 'fixture', refreshToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' },
      oauth: { clientId: 'fixture', clientSecret: 'fixture' },
    },
  }, { calendarFetch: fetcher });
  return { rows, result, complete, fetcher };
}

describe('Calendar creation identity across model retry rounds', () => {
  it('reuses the original event when a retry changes an offset time into equivalent UTC', async () => {
    const { rows, result } = await createInOneTurn([
      { summary: 'Study block', start: { dateTime: '2026-10-03T15:00:00-05:00', timeZone: 'America/Chicago' }, end: { dateTime: '2026-10-03T16:00:00-05:00', timeZone: 'America/Chicago' } },
      { summary: 'Study block', start: { dateTime: '2026-10-03T20:00:00.000Z' }, end: { dateTime: '2026-10-03T21:00:00Z' } },
    ]);
    expect(rows.size).toBe(1);
    expect(result.calendarMutations).toHaveLength(2);
    expect(result.calendarMutations[1].id).toBe(result.calendarMutations[0].id);
    expect([...rows.values()][0].start).toEqual({ dateTime: '2026-10-03T15:00:00-05:00', timeZone: 'America/Chicago' });
  });

  it('avoids a duplicate from title whitespace differences while retaining exact title verification', async () => {
    const start = { dateTime: '2026-10-03T20:00:00Z' }, end = { dateTime: '2026-10-03T21:00:00Z' };
    const { rows, result } = await createInOneTurn([
      { summary: 'Study  block', start, end }, { summary: ' Study block ', start, end },
    ]);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].summary).toBe('Study  block');
    expect(result.calendarMutations).toHaveLength(1);
  });

  it('keeps genuinely different instants distinct', async () => {
    const { rows } = await createInOneTurn([
      { summary: 'Study block', start: { dateTime: '2026-10-03T15:00:00-05:00' }, end: { dateTime: '2026-10-03T16:00:00-05:00' } },
      { summary: 'Study block', start: { dateTime: '2026-10-03T15:00:00-04:00' }, end: { dateTime: '2026-10-03T16:00:00-04:00' } },
    ]);
    expect(rows.size).toBe(2);
  });

  it('preserves floating local timezones instead of treating them as UTC', async () => {
    const { rows } = await createInOneTurn(['America/Chicago', 'America/New_York'].map(timeZone => ({
      summary: 'Study block', start: { dateTime: '2026-10-03T15:00:00', timeZone }, end: { dateTime: '2026-10-03T16:00:00', timeZone },
    })));
    expect(rows.size).toBe(2);
  });

  it('preserves all-day dates and their exclusive end rather than converting them into timed events', async () => {
    const { rows } = await createInOneTurn([
      { summary: 'Study block', start: { date: '2026-10-03' }, end: { date: '2026-10-04' } },
      { summary: 'Study block', start: { dateTime: '2026-10-03T00:00:00Z' }, end: { dateTime: '2026-10-04T00:00:00Z' } },
    ]);
    expect(rows.size).toBe(2);
    expect([...rows.values()][0].start).toEqual({ date: '2026-10-03' });
    expect([...rows.values()][0].end).toEqual({ date: '2026-10-04' });
  });

  it('does not collapse distinct fractional instants that Date would round to the same millisecond', async () => {
    const { rows } = await createInOneTurn(['0001', '0002'].map(fraction => ({
      summary: 'Study block', start: { dateTime: `2026-10-03T20:00:00.${fraction}Z` }, end: { dateTime: '2026-10-03T21:00:00Z' },
    })));
    expect(rows.size).toBe(2);
  });
});
