import { describe, expect, it, vi } from 'vitest';
import { boundedEvidence, boundedHistory, compactCourseIndex, documentEvidence, gatherAcademicContext, localCalendarEvidence, needsAcademicContext } from '../src/academic-context';

describe('cross-source academic evidence', () => {
  it('checks both providers, keeps partial failures, and labels Google as a mirror rather than submission proof', async () => {
    const canvasFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses') return Response.json([{ id: 10, name: 'CS' }]);
      if (url.pathname.endsWith('/assignments')) return Response.json([{ id: 20, name: 'Reading', due_at: '2026-10-03T04:59:00Z', submission: { workflow_state: 'submitted' } }]);
      if (url.pathname === '/api/v1/calendar_events') return Response.json([]);
      return Response.json({}, { status: 404 });
    });
    const calendarFetch = vi.fn(async () => { throw new Error('temporary provider outage'); });
    const evidence = await gatherAcademicContext({ message: 'What is due next?', now: new Date('2026-10-02T16:00:00Z'),
      canvas: { canvasHost: 'school.instructure.com', cookies: [{ name: 'canvas_session', value: 'test', domain: 'school.instructure.com' }] },
      calendar: { tokens: { accessToken: 'test', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 3600000).toISOString() }, oauth: { clientId: 'client', clientSecret: 'test' } },
      canvasFetch, calendarFetch,
    });
    expect(evidence.sources.canvasAssignments).toMatchObject({ status: 'checked', data: { data: [{ submissionStatus: 'submitted' }] } });
    expect(evidence.sources.googleCalendar).toMatchObject({ status: 'unavailable' });
    expect(canvasFetch).toHaveBeenCalled(); expect(calendarFetch).toHaveBeenCalled();
  });

  it('does not spend retrieval calls for greetings, memories, or calendar edits', () => {
    expect(needsAcademicContext('When is my next assignment due?')).toBe(true);
    expect(needsAcademicContext('When is my next quiz?')).toBe(true);
    expect(needsAcademicContext("What's next?")).toBe(true);
    expect(needsAcademicContext('What do I have next?')).toBe(true);
    expect(needsAcademicContext('What have I got coming up for school?')).toBe(true);
    expect(needsAcademicContext('What is going on this week?')).toBe(true);
    expect(needsAcademicContext('Remember my next exam is Oct 9')).toBe(false);
    expect(needsAcademicContext('Add those exams to my calendar')).toBe(false);
    expect(needsAcademicContext('Thanks for finding my assignments')).toBe(false);
  });

  it.each(['When is my next quiz?', 'When is my next assessment?'])('uses the longer assessment window for %s', async (message) => {
    const now = new Date('2026-10-02T16:00:00Z');
    const canvasFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses') return Response.json([{ id: 10, name: 'CS' }]);
      if (url.pathname.endsWith('/assignments')) return Response.json([
        { id: 20, name: 'Quiz assessment', due_at: '2026-11-15T16:00:00Z' },
      ]);
      return Response.json([]);
    });
    const evidence = await gatherAcademicContext({ message, now, canvasFetch,
      canvas: { canvasHost: 'school.instructure.com', cookies: [{ name: 'canvas_session', value: 'test', domain: 'school.instructure.com' }] },
    });
    expect(Date.parse(evidence.window.end) - now.getTime()).toBe(120 * 86_400_000);
    expect(JSON.stringify(evidence.sources.canvasAssignments)).toContain('Quiz assessment');
  });

  it('bounds old conversation cost without cutting the current question or retaining an orphan answer', () => {
    const messages = [
      { role: 'user', content: 'old question' }, { role: 'assistant', content: 'x'.repeat(1000) },
      { role: 'user', content: 'current question'.repeat(20) },
    ];
    const result = boundedHistory(messages, 50);
    expect(result.messages).toEqual([messages[2]]);
    expect(result.omitted).toBe(2);
  });

  it('removes stale cached assignment bodies while preserving syllabus IDs and source freshness', () => {
    expect(compactCourseIndex([{ courseId: '10', syllabus: { attachmentIds: ['saved-1'] }, initializedAt: '2026-10-01', assignments: ['stale'], modules: ['large'] }])[0]).toMatchObject({ courseId: '10', syllabus: { attachmentIds: ['saved-1'] }, initializedAt: '2026-10-01' });
    expect(JSON.stringify(compactCourseIndex([{ assignments: ['stale'] }]))).not.toContain('stale');
  });

  it('finds late-document exam evidence within a bounded excerpt and marks omitted text', () => {
    const text = 'Course header\n' + Array.from({ length: 600 }, (_, i) => `Unrelated paragraph ${i}: ${'general policy '.repeat(10)}`).join('\n') + '\nMidterm exam Oct 9 at 2 PM\nExam location: room 104';
    const result = documentEvidence(text, 'When is my midterm exam?', 2000);
    expect(result.text).toContain('Midterm exam Oct 9');
    expect(result.text).toContain('room 104');
    expect(result.text.length).toBeLessThanOrEqual(2000);
    expect(result.excerpted).toBe(true);
  });

  it('enforces a character budget for high-volume sources and reports omitted records', () => {
    const result = boundedEvidence(Array.from({ length: 100 }, (_, id) => ({ id, body: 'x'.repeat(300) })), 50, 2000);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(2000);
    expect(result.omitted).toBe(100 - result.data.length);
  });

  it('retains all-day dates and labels the exclusive end while converting timed UTC events locally', () => {
    const event = { id: 'one', calendarId: 'primary', calendarName: 'Main', summary: 'Exam', description: null, location: null, status: 'confirmed', start: { date: '2026-10-03' }, end: { date: '2026-10-04' }, reminders: null, htmlLink: 'https://calendar.google.com', updatedAt: null };
    expect(localCalendarEvidence(event, 'America/Chicago')).toMatchObject({ startLocal: '2026-10-03', allDay: true, endExclusive: true });
    expect(localCalendarEvidence({ ...event, start: { dateTime: '2026-10-03T02:00:00Z' } }, 'America/Chicago').startLocal).toContain('October 2');
  });

  it('finds relevant evidence after a long header and in a long single-line paragraph', () => {
    const text = 'Header '.repeat(4000) + '\n' + 'Unrelated '.repeat(4000) + 'Midterm exam October 9 at 2 PM';
    expect(documentEvidence(text, 'midterm exam', 2000).text).toContain('Midterm exam October 9');
  });

  it('keeps unfinished grace-period work and today’s all-day deadline ahead of crowded future/completed records', async () => {
    const canvasFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses') return Response.json([{id:10,name:'CS'}]);
      if (url.pathname.endsWith('/assignments')) return Response.json([
        ...Array.from({length:100},(_,id)=>({id,name:`Excused ${id}`,due_at:'2026-10-03T04:59:00Z',submission:{excused:true}})),
        {id:999,name:'Unfinished grace reading',due_at:'2026-10-01T04:59:00Z',lock_at:'2026-10-03T04:59:00Z',submission:{workflow_state:'unsubmitted'}},
      ]);
      return Response.json([]);
    });
    const calendarFetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/calendarList')
      ? Response.json({items:[{id:'main',accessRole:'owner'}]})
      : Response.json({items:[
        ...Array.from({length:84},(_,id)=>({id:String(id),summary:'Future deadline',start:{date:'2026-10-03'},end:{date:'2026-10-04'}})),
        {id:'today',summary:'All-day deadline today',start:{date:'2026-10-02'},end:{date:'2026-10-03'}},
      ]}));
    const evidence=await gatherAcademicContext({message:'What work is due this week?',now:new Date('2026-10-02T16:00:00Z'),
      canvas:{canvasHost:'school.instructure.com',cookies:[{name:'canvas_session',value:'test',domain:'school.instructure.com'}]},
      calendar:{tokens:{accessToken:'test',refreshToken:'refresh',expiresAt:'2099-01-01T00:00:00Z'},oauth:{clientId:'test',clientSecret:'test'}},canvasFetch,calendarFetch});
    expect(JSON.stringify(evidence.sources.canvasAssignments)).toContain('Unfinished grace reading');
    expect(JSON.stringify(evidence.sources.googleCalendar)).toContain('All-day deadline today');
  });

  it('keeps upcoming and ongoing timed exams ahead of crowded elapsed events from earlier today', async () => {
    const earlier = Array.from({ length: 100 }, (_, id) => ({ id: String(id), summary: `Elapsed exam ${id}`,
      start: { dateTime: '2026-10-02T12:00:00Z' }, end: { dateTime: '2026-10-02T13:00:00Z' } }));
    const calendarFetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/calendarList')
      ? Response.json({ items: [{ id: 'main', accessRole: 'owner' }] })
      : Response.json({ items: [...earlier,
        { id: 'ongoing', summary: 'Ongoing exam', start: { dateTime: '2026-10-02T15:00:00Z' }, end: { dateTime: '2026-10-02T17:00:00Z' } },
        { id: 'upcoming', summary: 'Next exam this afternoon', start: { dateTime: '2026-10-02T18:00:00Z' }, end: { dateTime: '2026-10-02T19:00:00Z' } },
      ] }));
    const canvasFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/courses') return Response.json([{ id: 10, name: 'CS' }]);
      if (url.pathname.endsWith('/assignments')) return Response.json([]);
      return Response.json([
        ...earlier.map(item => ({ id: item.id, title: item.summary, start_at: item.start.dateTime, end_at: item.end.dateTime, context_code: 'course_10' })),
        { id: 'canvas-next', title: 'Next exam this afternoon', start_at: '2026-10-02T18:00:00Z', end_at: '2026-10-02T19:00:00Z', context_code: 'course_10' },
      ]);
    });
    const evidence = await gatherAcademicContext({ message: 'When is my next exam?', now: new Date('2026-10-02T16:00:00Z'),
      calendar: { tokens: { accessToken: 'test', refreshToken: 'refresh', expiresAt: '2099-01-01T00:00:00Z' }, oauth: { clientId: 'test', clientSecret: 'test' } },
      canvas: { canvasHost: 'school.instructure.com', cookies: [{ name: 'canvas_session', value: 'test', domain: 'school.instructure.com' }] },
      calendarFetch, canvasFetch,
    });
    const google = evidence.sources.googleCalendar as { data: { events: Array<{ id: string }>; omitted: number } };
    expect(google.data.events.slice(0, 2).map(item => item.id)).toEqual(['ongoing', 'upcoming']);
    expect(google.data.omitted).toBeGreaterThan(0);
    expect(JSON.stringify(evidence.sources.canvasSchedule)).toContain('Next exam this afternoon');
  });
});
