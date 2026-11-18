import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarAdapter, type CalendarEvent, type GoogleCalendarConnection } from '@stuflo/calendar';
import { CanvasAdapter } from '@stuflo/lms';
import type { ModelCompletion, ModelGateway, ModelMessage, ModelToolCall } from '../src/model/model-gateway';
import { runStuTurn, type StuTurnInput } from '../src/turn';

const calendarConnection: GoogleCalendarConnection = {
  tokens: { accessToken: 'fake', refreshToken: 'fake', expiresAt: '2099-01-01T00:00:00Z' },
  oauth: { clientId: 'fake', clientSecret: 'fake' },
};

function completion(toolCalls: ModelToolCall[] = []): ModelCompletion {
  return { content: toolCalls.length ? '' : 'Done.', toolCalls, provider: 'test', model: 'test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
}

function readCall(id: string, args: Record<string, unknown> = {}): ModelToolCall {
  return { id, type: 'function', function: { name: 'canvas_read_saved_resource', arguments: JSON.stringify({ attachmentId: 'saved-1', ...args }) } };
}

function liveReadCall(id: string, external = false): ModelToolCall {
  return { id, type: 'function', function: { name: external ? 'canvas_read_external_resource' : 'canvas_read_file',
    arguments: JSON.stringify(external
      ? { courseId: '10', courseName: 'CS', url: 'https://example.edu/syllabus.pdf', purpose: 'syllabus' }
      : { courseId: '10', fileId: '88', purpose: 'syllabus' }) } };
}

function liveFile() {
  return { data: { file: { id: '88', courseId: '10', course: 'CS', name: 'Syllabus.pdf',
    contentType: 'application/pdf', sizeBytes: 8, updatedAt: '2026-10-02T12:00:00Z', locked: false,
    htmlUrl: 'https://school.instructure.com/courses/10/files/88', downloadUrl: null, folderId: null },
    bytes: new TextEncoder().encode('fake pdf').buffer }, warnings: [] };
}

const canvasConnection = { canvasHost: 'school.instructure.com', cookies: [{ name: 'canvas_session', value: 'fake', domain: 'school.instructure.com' }] };

function savedFile(text: string, contentType = 'text/plain', updatedAt = '2026-10-02T12:00:00Z') {
  return {
    file: { id: 'saved-1', name: contentType === 'application/pdf' ? 'Syllabus.pdf' : 'Syllabus.txt',
      contentType, sizeBytes: text.length, purpose: 'syllabus', sourceUrl: 'https://school.instructure.com/courses/10/assignments/syllabus',
      canvasHost: 'school.instructure.com', courseId: '10', courseName: 'CS', updatedAt: new Date(updatedAt) },
    bytes: new TextEncoder().encode(text).buffer,
  };
}

function storage(read: NonNullable<StuTurnInput['canvasStorage']>['read']): NonNullable<StuTurnInput['canvasStorage']> {
  return { read, list: vi.fn(), store: vi.fn(), storeText: vi.fn() };
}

function toolResult(messages: ModelMessage[], callId: string) {
  return JSON.parse(messages.find((message) => message.role === 'tool' && message.tool_call_id === callId)!.content!);
}

afterEach(() => vi.restoreAllMocks());

describe('bounded tool evidence', () => {
  it('reuses a saved text read across recursive rounds without repeating document text and resets next turn', async () => {
    const text = 'Attendance policy: private-sentinel must attend every lab.\n'.repeat(200);
    const read = vi.fn().mockResolvedValue(savedFile(text));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('first')]))
      .mockResolvedValueOnce(completion([readCall('repeat')]))
      .mockResolvedValueOnce(completion());
    const input: StuTurnInput = { messages: [{ role: 'user', content: 'Explain my attendance policy.' }], canvasStorage: storage(read) };
    await runStuTurn({ complete }, input);
    expect(read).toHaveBeenCalledOnce();
    const messages = complete.mock.calls[2][0].messages;
    expect(toolResult(messages, 'first').data.text).toContain('private-sentinel');
    expect(toolResult(messages, 'repeat')).toMatchObject({ data: { reused: true, priorToolCallId: 'first', contentAttachedToModel: false } });
    expect(toolResult(messages, 'repeat').data.text).toBeUndefined();
    expect(messages.find((message) => message.tool_call_id === 'repeat')!.content!.length).toBeLessThan(1500);

    const nextComplete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('new-turn')])).mockResolvedValueOnce(completion());
    await runStuTurn({ complete: nextComplete }, input);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('answers a new section query from cached text and normalizes duplicate query whitespace', async () => {
    const text = Array.from({ length: 300 }, (_, index) => `Attendance paragraph ${index}: ${'Attend labs. '.repeat(30)}`).join('\n') +
      '\nExamination section: exam takes place November 15 at noon. ' + 'Exam preparation notes. '.repeat(25);
    const read = vi.fn().mockResolvedValue(savedFile(text));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('attendance', { query: 'attendance' })]))
      .mockResolvedValueOnce(completion([readCall('exam', { section: 'Examination section' })]))
      .mockResolvedValueOnce(completion([readCall('exam-repeat', { section: '  Examination   section  ' })]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Explain attendance and my exam.' }], canvasStorage: storage(read) });
    expect(read).toHaveBeenCalledOnce();
    const messages = complete.mock.calls[3][0].messages;
    expect(toolResult(messages, 'attendance').data.text).not.toContain('November 15');
    expect(toolResult(messages, 'exam').data.text).toContain('November 15');
    expect(toolResult(messages, 'exam').data.textCoverage).toContain('other sections were omitted');
    expect(toolResult(messages, 'exam-repeat').data.priorToolCallId).toBe('exam');
    expect(toolResult(messages, 'exam-repeat').data.text).toBeUndefined();
  });

  it('keeps one original PDF in context when the same attachment is requested for several topics', async () => {
    const read = vi.fn().mockResolvedValue(savedFile('fake pdf', 'application/pdf'));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('pdf', { query: 'attendance' })]))
      .mockResolvedValueOnce(completion([readCall('pdf-again', { query: 'exam' })]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Explain the syllabus.' }], canvasStorage: storage(read) });
    expect(read).toHaveBeenCalledOnce();
    const messages = complete.mock.calls[2][0].messages;
    expect(messages.flatMap((message) => message.inputFiles || [])).toHaveLength(1);
    expect(toolResult(messages, 'pdf-again').data).toMatchObject({ originalFileAlreadyInContext: true, originalFileToolCallId: 'pdf', contentAttachedToModel: false });
  });

  it('refreshes the saved version once and bounds subsequent refresh requests truthfully', async () => {
    const read = vi.fn().mockResolvedValueOnce(savedFile('Exam is October 9.'))
      .mockResolvedValueOnce(savedFile('Exam moved to October 16.', 'text/plain', '2026-10-02T13:00:00Z'));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('old')]))
      .mockResolvedValueOnce(completion([readCall('fresh', { query: 'exam', refresh: true })]))
      .mockResolvedValueOnce(completion([readCall('refresh-loop', { refresh: true })]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'When is the exam?' }], canvasStorage: storage(read) });
    expect(read).toHaveBeenCalledTimes(2);
    const messages = complete.mock.calls[3][0].messages;
    expect(toolResult(messages, 'fresh').data.text).toContain('October 16');
    expect(toolResult(messages, 'refresh-loop')).toMatchObject({ error: 'refresh_limit', data: {
      priorToolCallId: 'fresh', file: { updatedAt: '2026-10-02T13:00:00.000Z' }, contentAttachedToModel: false,
    } });
  });

  it('does not claim unsupported saved document contents were inspected when returning a cache reference', async () => {
    const read = vi.fn().mockResolvedValue(savedFile('unknown', 'application/x-unknown'));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('unsupported'), readCall('repeat')]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Read the file.' }], canvasStorage: storage(read) });
    expect(read).toHaveBeenCalledOnce();
    expect(toolResult(complete.mock.calls[1][0].messages, 'repeat').data.textCoverage).toContain('not inspected');
  });

  it.each([false, true])('reuses repeated live file reads and their saved attachment alias (external=%s)', async (external) => {
    const download = vi.spyOn(CanvasAdapter.prototype, external ? 'downloadExternalResource' : 'downloadFile').mockResolvedValue(liveFile());
    const read = vi.fn();
    const store = vi.fn().mockResolvedValue({ id: 'saved-1', updatedAt: new Date('2026-10-02T12:30:00Z') });
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([liveReadCall('live', external)]))
      .mockResolvedValueOnce(completion([liveReadCall('live-repeat', external), readCall('saved-alias')]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Read my syllabus.' }], canvasConnection,
      canvasStorage: { ...storage(read), store } });
    expect(download).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    const messages = complete.mock.calls[2][0].messages;
    expect(messages.flatMap(message => message.inputFiles || [])).toHaveLength(1);
    expect(toolResult(messages, 'live-repeat').data).toMatchObject({ reused: true, priorToolCallId: 'live', originalFileAlreadyInContext: true });
    expect(toolResult(messages, 'saved-alias').data).toMatchObject({ originalFileAlreadyInContext: true, originalFileToolCallId: 'live' });
  });

  it('deduplicates identical PDF bytes across saved and live source aliases without hiding their source metadata', async () => {
    const download = vi.spyOn(CanvasAdapter.prototype, 'downloadFile').mockResolvedValue(liveFile());
    const read = vi.fn().mockResolvedValue(savedFile('fake pdf', 'application/pdf'));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('saved')]))
      .mockResolvedValueOnce(completion([liveReadCall('live-alias')]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Read my syllabus.' }], canvasConnection,
      canvasStorage: storage(read) });
    expect(download).toHaveBeenCalledOnce();
    const messages = complete.mock.calls[2][0].messages;
    expect(messages.flatMap(message => message.inputFiles || [])).toHaveLength(1);
    expect(toolResult(messages, 'live-alias').data).toMatchObject({ originalFileAlreadyInContext: true,
      originalFileToolCallId: 'saved', file: { htmlUrl: 'https://school.instructure.com/courses/10/files/88' } });
  });

  it.each([true, false])('only attaches a refreshed PDF again when its contents changed (unchanged=%s)', async (unchanged) => {
    const read = vi.fn().mockResolvedValueOnce(savedFile('original PDF', 'application/pdf'))
      .mockResolvedValueOnce(savedFile(unchanged ? 'original PDF' : 'changed PDF', 'application/pdf', '2026-10-02T13:00:00Z'));
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([readCall('original')]))
      .mockResolvedValueOnce(completion([readCall('refresh', { refresh: true })]))
      .mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'Read my syllabus.' }], canvasStorage: storage(read) });
    expect(read).toHaveBeenCalledTimes(2);
    const messages = complete.mock.calls[2][0].messages;
    expect(messages.flatMap(message => message.inputFiles || [])).toHaveLength(unchanged ? 1 : 2);
    const fresh = toolResult(messages, 'refresh').data;
    expect(fresh.file.updatedAt).toBe('2026-10-02T13:00:00.000Z');
    expect(fresh.contentAttachedToModel).toBe(!unchanged);
    if (unchanged) expect(fresh).toMatchObject({ originalFileAlreadyInContext: true, originalFileToolCallId: 'original' });
  });

  it('bounds calendar reads while retaining exact IDs, local dates and citation links', async () => {
    const events: CalendarEvent[] = Array.from({ length: 100 }, (_, index) => ({
      id: `event-${index}`, calendarId: 'primary', calendarName: 'My calendar', summary: `Study ${index}`,
      description: 'details '.repeat(2000), location: 'not-needed-location', status: 'confirmed',
      start: { dateTime: '2026-10-03T02:00:00Z' }, end: { dateTime: '2026-10-03T03:00:00Z' },
      reminders: { useDefault: true, overrides: [] }, htmlLink: `https://calendar.google.com/event?eid=${index}`, updatedAt: '2026-10-02T12:00:00Z',
    }));
    vi.spyOn(GoogleCalendarAdapter.prototype, 'listEvents').mockResolvedValue(events);
    const complete = vi.fn<ModelGateway['complete']>()
      .mockResolvedValueOnce(completion([{ id: 'events', type: 'function', function: {
        name: 'calendar_list_events', arguments: '{"timeMin":"2026-10-02T00:00:00Z","timeMax":"2026-10-04T00:00:00Z"}',
      } }])).mockResolvedValueOnce(completion());
    await runStuTurn({ complete }, { messages: [{ role: 'user', content: 'What is on my calendar?' }],
      calendarConnection, timeZone: 'America/Chicago' });
    const result = toolResult(complete.mock.calls[1][0].messages, 'events');
    expect(JSON.stringify(result.events).length).toBeLessThanOrEqual(8000);
    expect(result.omitted).toBe(100 - result.events.length);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.events[0]).toMatchObject({ id: 'event-0', calendarId: 'primary', summary: 'Study 0',
      htmlLink: 'https://calendar.google.com/event?eid=0', updatedAt: '2026-10-02T12:00:00Z' });
    expect(result.events[0].description.length).toBe(500);
    expect(result.events[0].startLocal).toContain('October 2');
    expect(result.events[0].reminders).toBeUndefined();
    expect(result.coverage).toContain('Narrow');
  });
});
