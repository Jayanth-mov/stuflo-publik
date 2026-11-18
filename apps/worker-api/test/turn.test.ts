import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../src/model/model-gateway';
import { runStuTurn } from '../src/turn';

describe('runStuTurn', () => {
  it('executes five requested memory operations instead of silently dropping the fifth', async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({ id: `memory-${index}`, type: 'function' as const, function: { name: 'memory_search', arguments: '{"query":"study"}' } }));
    const complete = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: calls, provider: 'openai', model: 'test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })
      .mockResolvedValueOnce({ content: 'Done', toolCalls: [], provider: 'openai', model: 'test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
    const search = vi.fn().mockResolvedValue({ memories: [] });
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'What do you remember?' }], memory: { search, remember: vi.fn(), forget: vi.fn() } });
    expect(search).toHaveBeenCalledTimes(5);
    expect(complete.mock.calls[1][0].messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(5);
  });

  it('answers every requested tool call with valid JSON when the execution cap or result size is exceeded', async () => {
    const calls = Array.from({ length: 9 }, (_, index) => ({ id: `memory-${index}`, type: 'function' as const, function: { name: 'memory_search', arguments: '{"query":"study"}' } }));
    const complete = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: calls, provider: 'openai', model: 'test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })
      .mockResolvedValueOnce({ content: 'Done', toolCalls: [], provider: 'openai', model: 'test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
    const search = vi.fn().mockResolvedValue({ content: 'x'.repeat(70_000) });
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Find memories' }], memory: { search, remember: vi.fn(), forget: vi.fn() } });
    const outputs = complete.mock.calls[1][0].messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => JSON.parse(message.content));
    expect(outputs).toHaveLength(9);
    expect(outputs[0].error).toBe('result_too_large');
    expect(outputs[8].error).toBe('tool_round_limit');
    expect(search).toHaveBeenCalledTimes(8);
  });
  it('executes the typed Canvas assignments tool and returns the final response', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'canvas_get_assignments', arguments: '{"includeUndated":false}' },
            },
          ],
          provider: 'openai',
          model: 'openai/gpt-4.1',
          usage: { inputTokens: 10, outputTokens: 3 },
        })
        .mockResolvedValueOnce({
          content: 'Your lab report is due Friday.',
          toolCalls: [],
          provider: 'openai',
          model: 'openai/gpt-4.1',
          usage: { inputTokens: 40, outputTokens: 8 },
        }),
    };
    const canvasFetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses') return Response.json([{ id: 10, name: 'Biology' }]);
      if (url.pathname === '/api/v1/courses/10/assignments') {
        return Response.json([{ id: 101, name: 'Lab report', due_at: '2026-08-08T04:00:00Z' }]);
      }
      return Response.json({}, { status: 404 });
    });
    const result = await runStuTurn(
      model,
      {
        messages: [{ role: 'user', content: "What's due?" }],
        canvasConnection: {
          canvasHost: 'school.instructure.com',
          cookies: [{ name: 'canvas_session', value: 'secret', domain: 'school.instructure.com' }],
        },
      },
      { canvasFetch },
    );
    expect(result.reply).toBe('Your lab report is due Friday.');
    expect(result.toolsUsed).toEqual(['canvas_get_assignments']);
    expect(model.complete).toHaveBeenCalledTimes(2);
    expect((model.complete as ReturnType<typeof vi.fn>).mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', tool_call_id: 'call-1' }),
      ]),
    );
  });

  it('reloads the latest extension-synced Canvas cookies immediately before a tool call', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'fresh-canvas',
            type: 'function',
            function: { name: 'canvas_list_courses', arguments: '{}' },
          }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'Canvas is current.',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    const canvasFetch = vi.fn(async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.cookie !== 'canvas_session=fresh') return new Response('', { status: 302 });
      return Response.json([{ id: 10, name: 'Biology' }]);
    });
    const loadCanvasConnection = vi.fn().mockResolvedValue({
      canvasHost: 'school.instructure.com',
      cookies: [{ name: 'canvas_session', value: 'fresh', domain: 'school.instructure.com' }],
    });
    const result = await runStuTurn(model, {
      messages: [{ role: 'user', content: 'Show my Canvas courses.' }],
      canvasConnection: {
        canvasHost: 'school.instructure.com',
        cookies: [{ name: 'canvas_session', value: 'stale', domain: 'school.instructure.com' }],
      },
    }, { canvasFetch, loadCanvasConnection });

    expect(result.reply).toBe('Canvas is current.');
    expect(loadCanvasConnection).toHaveBeenCalledOnce();
    expect(canvasFetch).toHaveBeenCalledOnce();
  });

  it('marks a rejected Canvas tool request suspect without claiming the login definitely expired', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'canvas-expired',
              type: 'function',
              function: { name: 'canvas_list_courses', arguments: '{}' },
            },
          ],
          provider: 'openai',
          model: 'openai/gpt-4.1',
          usage: { inputTokens: 10, outputTokens: 3 },
        })
        .mockResolvedValueOnce({
          content: 'Canvas was temporarily unavailable for that check, but your saved connection was kept.',
          toolCalls: [],
          provider: 'openai',
          model: 'openai/gpt-4.1',
          usage: { inputTokens: 25, outputTokens: 8 },
        }),
    };
    const onCanvasConnectionInvalid = vi.fn();
    const result = await runStuTurn(
      model,
      {
        messages: [{ role: 'user', content: 'Show my Canvas courses.' }],
        canvasConnection: {
          canvasHost: 'school.instructure.com',
          cookies: [{ name: 'canvas_session', value: 'expired', domain: 'school.instructure.com' }],
        },
      },
      {
        canvasFetch: vi.fn(async () => new Response(null, {
          status: 302,
          headers: { location: 'https://school.instructure.com/login' },
        })),
        onCanvasConnectionInvalid,
      },
    );

    expect(result.reply).toContain('temporarily unavailable');
    expect(onCanvasConnectionInvalid).toHaveBeenCalledOnce();
    expect(onCanvasConnectionInvalid).toHaveBeenCalledWith('session_expired', expect.objectContaining({ canvasHost: 'school.instructure.com' }));
    const secondModelInput = (model.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondModelInput.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'canvas-expired',
          content: expect.stringContaining('canvas_session_unverified'),
        }),
      ]),
    );
  });

  it('executes Calendar REST tools without exposing a delete capability', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'calendar-call-1',
              type: 'function',
              function: {
                name: 'calendar_list_events',
                arguments:
                  '{"timeMin":"2026-08-06T00:00:00Z","timeMax":"2026-08-13T00:00:00Z"}',
              },
            },
          ],
          provider: 'openai',
          model: 'openai/gpt-4.1',
          usage: { inputTokens: 10, outputTokens: 3 },
        })
        .mockResolvedValueOnce({
          content: 'You have a study block tomorrow.',
          toolCalls: [],
          provider: 'openai',
          model: 'openai/gpt-4.1',
          usage: { inputTokens: 30, outputTokens: 7 },
        }),
    };
    const calendarFetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/users/me/calendarList')) {
        return Response.json({ items: [{ id: 'primary', summary: 'Primary', accessRole: 'owner' }] });
      }
      if (url.pathname.endsWith('/calendars/primary/events')) {
        return Response.json({
          items: [
            {
              id: 'event-1',
              summary: 'Study block',
              start: { dateTime: '2026-08-07T10:00:00-05:00' },
              end: { dateTime: '2026-08-07T11:00:00-05:00' },
            },
          ],
        });
      }
      return Response.json({}, { status: 404 });
    });
    const result = await runStuTurn(
      model,
      {
        messages: [{ role: 'user', content: 'What is on my calendar this week?' }],
        calendarConnection: {
          tokens: {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          oauth: { clientId: 'client-id', clientSecret: 'client-secret' },
        },
      },
      { calendarFetch },
    );
    expect(result.reply).toContain('study block');
    expect(result.toolsUsed).toEqual(['calendar_list_events']);
    const firstModelInput = (model.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstModelInput.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain(
      'calendar_delete_event',
    );
  });

  it('resolves a calendar display name and preserves pasted meeting details and reminders', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'create-event',
            type: 'function',
            function: {
              name: 'calendar_create_event',
              arguments: JSON.stringify({
                calendarId: 'Jayanth',
                summary: 'Jayanth + Griffin: Quad',
                start: { dateTime: '2026-08-09T10:00:00-05:00' },
                end: { dateTime: '2026-08-09T10:30:00-05:00' },
                reminderMinutesBefore: [60, 120],
              }),
            },
          }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'Added it with both reminders and all meeting details.',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    let postedBody: Record<string, unknown> = {};
    const persistedEvent = {
      id: 'event-1',
      summary: 'Jayanth + Griffin: Quad',
      description: [
        'Google Meet joining info',
        'Video call link: https://meet.google.com/hve-mebg-qfd',
        'Or dial: +1 256-907-1023 PIN: 611249552',
        'More phone numbers: https://tel.meet/hve-mebg-qfd?pin=2753889721384',
      ].join('\n'),
      start: { dateTime: '2026-08-09T10:00:00-05:00' },
      end: { dateTime: '2026-08-09T10:30:00-05:00' },
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 120 }],
      },
      htmlLink: 'https://calendar.google.com/event?eid=event-1',
    };
    const calendarFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/users/me/calendarList')) {
        return Response.json({
          items: [{ id: 'jayanth@example.com', summary: 'Jayanth', primary: true, accessRole: 'owner' }],
        });
      }
      if (url.pathname.endsWith('/calendars/jayanth%40example.com/events') && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body));
        return Response.json(persistedEvent);
      }
      if (url.pathname.endsWith('/calendars/jayanth%40example.com/events/event-1')) {
        return Response.json(persistedEvent);
      }
      return Response.json({}, { status: 404 });
    });
    const result = await runStuTurn(model, {
      requestText: 'Add the above event to my default Google Calendar named Jayanth and remind me one and two hours before.',
      messages: [
        {
          role: 'user',
          content: `Jayanth + Griffin: Quad
Sunday, Aug 9 · 10–10:30 AM
Google Meet joining info
Video call link: https://meet.google.com/hve-mebg-qfd
Or dial: +1 256-907-1023 PIN: 611249552
More phone numbers: https://tel.meet/hve-mebg-qfd?pin=2753889721384

Add the above event to my Google Calendar and remind me one and two hours before.`,
        },
        { role: 'assistant', content: 'Please confirm the date and calendar.' },
        { role: 'user', content: 'The date is correct. Use my default Google Calendar named Jayanth.' },
      ],
      calendarConnection: {
        tokens: { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: '2099-01-01T00:00:00.000Z' },
        oauth: { clientId: 'client-id', clientSecret: 'client-secret' },
      },
    }, { calendarFetch });

    expect(postedBody).toMatchObject({
      description: expect.stringContaining('https://meet.google.com/hve-mebg-qfd'),
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 120 }],
      },
    });
    expect(result.calendarMutations).toEqual([
      expect.objectContaining({ id: 'event-1', calendarId: 'jayanth@example.com' }),
    ]);
  });

  it('restores meeting details from conversation history for a follow-up event update', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'update-event',
            type: 'function',
            function: {
              name: 'calendar_update_event',
              arguments: '{"calendarId":"primary","eventId":"event-1"}',
            },
          }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'The meeting details are now saved on the event.',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    let patchedBody: Record<string, unknown> = {};
    const description = 'Video call link: https://meet.google.com/hve-mebg-qfd\nOr dial: +1 256-907-1023 PIN: 611249552';
    const persistedEvent = {
      id: 'event-1',
      summary: 'Jayanth + Griffin: Quad',
      description,
      start: { dateTime: '2026-08-09T10:00:00-05:00' },
      end: { dateTime: '2026-08-09T10:30:00-05:00' },
    };
    const calendarFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/users/me/calendarList')) {
        return Response.json({
          items: [{ id: 'jayanth@example.com', summary: 'Jayanth', primary: true, accessRole: 'owner' }],
        });
      }
      if (url.pathname.endsWith('/events/event-1') && init?.method === 'PATCH') {
        patchedBody = JSON.parse(String(init.body));
        return Response.json({ id: 'event-1' });
      }
      if (url.pathname.endsWith('/events/event-1')) return Response.json(persistedEvent);
      return Response.json({}, { status: 404 });
    });
    const result = await runStuTurn(model, {
      messages: [
        {
          role: 'user',
          content: `Jayanth + Griffin: Quad
Video call link: https://meet.google.com/hve-mebg-qfd
Or dial: +1 256-907-1023 PIN: 611249552`,
        },
        { role: 'assistant', content: 'Added it to your primary calendar.' },
        { role: 'user', content: 'You forgot the video call and dial-in details. Add those details to the event please.' },
      ],
      calendarConnection: {
        tokens: { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: '2099-01-01T00:00:00.000Z' },
        oauth: { clientId: 'client-id', clientSecret: 'client-secret' },
      },
    }, { calendarFetch });

    expect(patchedBody.description).toBe(description);
    expect(result.calendarMutations[0]).toMatchObject({ id: 'event-1', description });
  });

  it('saves explicit long-term memory through a bounded callback', async () => {
    const remember = vi.fn().mockResolvedValue({ id: 'memory-1' });
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'memory-call-1',
            type: 'function',
            function: { name: 'memory_remember', arguments: '{"category":"preference","content":"Prefers worked examples"}' },
          }],
          provider: 'workers-ai',
          model: '@cf/moonshotai/kimi-k2.6',
          usage: { inputTokens: 10, outputTokens: 2 },
        })
        .mockResolvedValueOnce({
          content: 'I’ll remember that.',
          toolCalls: [],
          provider: 'workers-ai',
          model: '@cf/moonshotai/kimi-k2.6',
          usage: { inputTokens: 20, outputTokens: 4 },
        }),
    };
    const result = await runStuTurn(model, {
      messages: [{ role: 'user', content: 'Remember that I prefer worked examples.' }],
      memory: { remember, forget: vi.fn() },
    });
    expect(remember).toHaveBeenCalledWith({ category: 'preference', content: 'Prefers worked examples' });
    expect(result.toolsUsed).toEqual(['memory_remember']);
  });

  it('continues through multiple Canvas navigation steps before answering', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'pages', type: 'function', function: { name: 'canvas_list_pages', arguments: '{"courseId":"10"}' } }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'page', type: 'function', function: { name: 'canvas_get_page', arguments: '{"courseId":"10","pageUrl":"weekly-schedule"}' } }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'Your class meets Monday at 10:00. [Open the schedule](https://school.instructure.com/courses/10/pages/weekly-schedule)',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    const canvasFetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses') return Response.json([{ id: 10, name: 'Biology' }]);
      if (url.pathname === '/api/v1/courses/10/pages') {
        return Response.json([{ url: 'weekly-schedule', title: 'Weekly schedule' }]);
      }
      if (url.pathname === '/api/v1/courses/10/pages/weekly-schedule') {
        return Response.json({ url: 'weekly-schedule', title: 'Weekly schedule', body: '<p>Monday at 10:00</p>' });
      }
      if (url.pathname === '/api/v1/courses/10') return Response.json({ id: 10, name: 'Biology' });
      return Response.json({}, { status: 404 });
    });
    const result = await runStuTurn(model, {
      messages: [{ role: 'user', content: 'When does Biology meet?' }],
      canvasConnection: {
        canvasHost: 'school.instructure.com',
        cookies: [{ name: 'canvas_session', value: 'secret', domain: 'school.instructure.com' }],
      },
    }, { canvasFetch });
    expect(result.toolsUsed).toEqual(['canvas_list_pages', 'canvas_get_page']);
    expect(result.reply).toContain('Monday at 10:00');
    expect(model.complete).toHaveBeenCalledTimes(3);
  });

  it('recovers from an API miss and continues through the Canvas browser fallback', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'missing-page', type: 'function', function: { name: 'canvas_get_page', arguments: '{"courseId":"10","pageUrl":"home"}' } }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'browser-page', type: 'function', function: { name: 'canvas_browser_read_page', arguments: '{"url":"https://school.instructure.com/courses/10"}' } }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'The rendered course home page links to the syllabus.',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    const canvasFetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses/10') return Response.json({ id: 10, name: 'Biology' });
      return Response.json({}, { status: 404 });
    });
    const canvasBrowserRead = vi.fn().mockResolvedValue({
      requestedUrl: 'https://school.instructure.com/courses/10',
      finalUrl: 'https://school.instructure.com/courses/10',
      title: 'Biology',
      text: 'Course home. Open the syllabus.',
      links: [{ label: 'Syllabus', url: 'https://school.instructure.com/courses/10/assignments/syllabus', apiUrl: null, kind: null, external: false }],
    });
    const result = await runStuTurn(model, {
      messages: [{ role: 'user', content: 'Find the syllabus from the Biology home page.' }],
      canvasConnection: {
        canvasHost: 'school.instructure.com',
        cookies: [{ name: 'canvas_session', value: 'secret', domain: 'school.instructure.com' }],
      },
    }, { canvasFetch, canvasBrowserRead });
    expect(result.reply).toContain('links to the syllabus');
    expect(result.toolsUsed).toEqual(['canvas_get_page', 'canvas_browser_read_page']);
    expect(canvasBrowserRead).toHaveBeenCalledOnce();
    const secondRequest = (model.complete as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('not_found') }),
    ]));
  });

  it('stores and attaches a downloaded Canvas file to the next model call', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'file',
            type: 'function',
            function: { name: 'canvas_read_file', arguments: '{"courseId":"10","fileId":"88","purpose":"syllabus"}' },
          }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'The syllabus says attendance is required.',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    const canvasFetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/files/88') {
        return Response.json({ id: 88, context_id: 10, context_type: 'Course', display_name: 'Syllabus.pdf', 'content-type': 'application/pdf', size: 8, url: 'https://school.instructure.com/files/88/download' });
      }
      if (url.pathname === '/api/v1/courses/10') return Response.json({ id: 10, name: 'Biology' });
      if (url.pathname === '/files/88/download') {
        return new Response('fake pdf', { headers: { 'content-type': 'application/pdf' } });
      }
      return Response.json({}, { status: 404 });
    });
    const store = vi.fn().mockResolvedValue({ id: 'stored-88' });
    const result = await runStuTurn(model, {
      messages: [{ role: 'user', content: 'Read my Biology syllabus.' }],
      canvasConnection: {
        canvasHost: 'school.instructure.com',
        cookies: [{ name: 'canvas_session', value: 'secret', domain: 'school.instructure.com' }],
      },
      canvasStorage: {
        store,
        storeText: vi.fn(),
        list: vi.fn().mockResolvedValue({ files: [], bytesUsed: 0, fileCount: 0, quotaBytes: 100 }),
        read: vi.fn(),
      },
    }, { canvasFetch });
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'syllabus', courseId: '10' }));
    const secondMessages = (model.complete as ReturnType<typeof vi.fn>).mock.calls[1][0].messages;
    expect(secondMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        inputFiles: [expect.objectContaining({ name: 'Syllabus.pdf', mimeType: 'application/pdf' })],
      }),
    ]));
    expect(result.reply).toContain('attendance is required');
  });

  it('answers from a saved syllabus even when the live Canvas session is unavailable', async () => {
    const model: ModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'list-saved',
            type: 'function',
            function: { name: 'canvas_list_saved_resources', arguments: '{}' },
          }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{
            id: 'read-saved',
            type: 'function',
            function: { name: 'canvas_read_saved_resource', arguments: '{"attachmentId":"1f55cfaf-1a2b-4c3d-8e9f-0123456789ab"}' },
          }],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        })
        .mockResolvedValueOnce({
          content: 'Your saved syllabus says attendance is required.',
          toolCalls: [],
          provider: 'openai', model: 'gpt-5.6-terra', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }),
    };
    const read = vi.fn().mockResolvedValue({
      file: {
        id: '1f55cfaf-1a2b-4c3d-8e9f-0123456789ab',
        name: 'Biology Syllabus.txt',
        contentType: 'text/plain',
        sizeBytes: 43,
        purpose: 'syllabus',
        sourceUrl: 'https://school.instructure.com/courses/10/assignments/syllabus',
        canvasHost: 'school.instructure.com',
        courseId: '10',
        courseName: 'Biology',
        updatedAt: new Date('2026-09-03T12:00:00Z'),
      },
      bytes: new TextEncoder().encode('Attendance is required for every lab.').buffer,
    });
    const result = await runStuTurn(model, {
      messages: [{ role: 'user', content: 'What does my Biology syllabus say about attendance?' }],
      canvasStorage: {
        store: vi.fn(),
        storeText: vi.fn(),
        list: vi.fn().mockResolvedValue({
          files: [{
            id: '1f55cfaf-1a2b-4c3d-8e9f-0123456789ab',
            fileName: 'Biology Syllabus.txt',
            mimeType: 'text/plain',
            sizeBytes: 43,
            purpose: 'syllabus',
            courseId: '10',
            courseName: 'Biology',
            sourceUrl: 'https://school.instructure.com/courses/10/assignments/syllabus',
            createdAt: new Date('2026-09-03T12:00:00Z'),
            updatedAt: new Date('2026-09-03T12:00:00Z'),
            url: '/v1/attachments/1f55cfaf-1a2b-4c3d-8e9f-0123456789ab',
          }],
          bytesUsed: 43,
          fileCount: 1,
          quotaBytes: 100,
        }),
        read,
      },
    });
    expect(result.toolsUsed).toEqual(['canvas_list_saved_resources', 'canvas_read_saved_resource']);
    expect(read).toHaveBeenCalledWith('1f55cfaf-1a2b-4c3d-8e9f-0123456789ab');
    expect(result.reply).toContain('attendance is required');
    const finalMessages = (model.complete as ReturnType<typeof vi.fn>).mock.calls[2][0].messages;
    expect(finalMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('Attendance is required for every lab.') }),
    ]));
    expect(finalMessages.filter((message: { inputFiles?: unknown[] }) => message.inputFiles)).toHaveLength(0);
  });
});
