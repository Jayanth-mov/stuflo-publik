import { CanvasAdapter, type CanvasConnection } from '@stuflo/lms';
import { GoogleCalendarAdapter, type GoogleCalendarConnection, type CalendarEvent } from '@stuflo/calendar';

const DAY = 86_400_000;
const EXAM = /\b(?:exam|midterm|final|test|assessment)s?\b|\bquiz(?:zes)?\b/i;

export function boundedEvidence<T>(records: T[], maxRecords: number, maxChars: number) {
  const data: T[] = [];
  let size = 2;
  for (const record of records) {
    const characters = JSON.stringify(record).length + 1;
    if (data.length < maxRecords && size + characters <= maxChars) { data.push(record); size += characters; }
  }
  return { data, omitted: records.length - data.length };
}

export function localCalendarEvidence(event: CalendarEvent, timeZone: string) {
  const format = (value: CalendarEvent['start']) => {
    if (value.date) return value.date;
    const instant = Date.parse(value.dateTime || '');
    return Number.isFinite(instant) ? new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(instant) : null;
  };
  return { id: event.id, calendarId: event.calendarId, calendarName: event.calendarName, summary: event.summary,
    start: event.start, end: event.end, startLocal: format(event.start), endLocal: format(event.end),
    allDay: Boolean(event.start.date), endExclusive: Boolean(event.end.date), description: event.description?.slice(0, 250) ?? null,
    url: event.htmlLink, updatedAt: event.updatedAt };
}

/** Fetch both live sources for deadline questions before the model can pick only one. */
export function needsAcademicContext(message: string) {
  if (/^\s*(?:remember|forget|save (?:this|that)|thanks?|thank you)\b/i.test(message)) return false;
  if (/^\s*(?:add|create|move|reschedule|update|change)\b/i.test(message)) return false;
  return /\b(?:due|deadlines?|exams?|midterms?|finals?|tests?|quiz(?:zes)?|assessments?|assignments?|homework|workload)\b/i.test(message)
    || /\b(?:what|anything|everything)\b.*\b(?:today|tomorrow|this week|next week|schedule)\b/i.test(message)
    || /^\s*what(?:'s| is)?\s+(?:coming up|next|left)(?:\s+for me)?\s*[?!.]*\s*$/i.test(message)
    || /^\s*what\s+(?:do i have|have i got)\s+(?:next|coming up)(?:\s+for (?:me|class|classes|school))?\s*[?!.]*\s*$/i.test(message)
    || /\bmy (?:week|day)\b.*\blook\b/i.test(message);
}

export async function gatherAcademicContext(input: {
  message: string;
  now: Date;
  canvas?: CanvasConnection;
  calendar?: GoogleCalendarConnection;
  canvasFetch?: typeof fetch;
  calendarFetch?: typeof fetch;
  timeZone?: string;
  onCanvasInvalid?: (connection: CanvasConnection) => Promise<void>;
}) {
  const examQuestion = EXAM.test(input.message);
  const endDays = examQuestion ? 120 : 21;
  const start = new Date(input.now.getTime() - 7 * DAY).toISOString();
  const end = new Date(input.now.getTime() + endDays * DAY).toISOString();
  const sources: Record<string, unknown> = {};
  const readSource = async (name: string, connected: boolean, read: () => Promise<unknown>) => {
    if (!connected) { sources[name] = { status: 'not_connected' }; return; }
    try { sources[name] = { status: 'checked', data: await read() }; }
    catch (error) {
      const code = (error as { code?: string })?.code || 'temporarily_unavailable';
      sources[name] = { status: 'unavailable', code };
      if (name.startsWith('canvas') && code === 'session_expired' && input.canvas) {
        await input.onCanvasInvalid?.(input.canvas).catch(() => undefined);
      }
    }
  };
  const timeZone = input.timeZone || input.canvas?.timeZone || 'America/Chicago';
  const localDay = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  };
  const today = localDay(input.now);
  const isPastDay = (value: string | null | undefined) => {
    if (!value) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value < today;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && localDay(new Date(parsed)) < today;
  };
  const prioritize = <T,>(records: T[], name: (record: T) => string, date: (record: T) => string | null | undefined, done: (record: T) => boolean = () => false, stillOpen: (record: T) => boolean = () => false, elapsed?: (record: T) => boolean) => {
    const rank = (record: T) => (done(record) ? 4 : 0) + ((elapsed ? elapsed(record) : isPastDay(date(record))) && !stillOpen(record) ? 2 : 0) + (examQuestion && !EXAM.test(name(record)) ? 8 : 0);
    return [...records].sort((a, b) => rank(a) - rank(b) || Date.parse(date(a) || '') - Date.parse(date(b) || ''));
  };
  // Share only this request's adapter; course-list reads can be coalesced without
  // turning stale cached submissions into current evidence.
  let canvas: CanvasAdapter | undefined;
  const canvasAdapter = () => canvas ||= new CanvasAdapter(input.canvas!, { fetch: input.canvasFetch });
  await Promise.all([
    readSource('canvasAssignments', Boolean(input.canvas), async () => {
      const result = await canvasAdapter().listAssignments({ dueAfter: start, dueBefore: end, includeUndated: false });
      const records = prioritize(result.data, item => item.name, item => item.dueAt,
        item => ['submitted', 'graded', 'pending_review', 'excused'].includes(item.submissionStatus || '') || (item.submissionStatus === 'late' && Boolean(item.submission?.submittedAt || ['submitted', 'pending_review', 'graded'].includes(item.submission?.workflowState || ''))),
        item => !examQuestion && Date.parse(item.lockAt || '') > input.now.getTime()).map(item => ({
        id: item.id, courseId: item.courseId, course: item.course, name: item.name, dueAt: item.dueAt, dueAtLocal: item.dueAtLocal,
        submissionStatus: item.submissionStatus, workflowState: item.submission?.workflowState, submittedAt: item.submission?.submittedAt, grade: item.submission?.grade, missing: item.submission?.missing,
        lockAt: item.lockAt, url: item.url,
      }));
      return { ...boundedEvidence(records, 80, 8_000), warnings: result.warnings, coverage: 'Dated assignments in this window only; consult saved syllabi for undated or off-Canvas work.' };
    }),
    readSource('canvasSchedule', Boolean(input.canvas), async () => {
      const result = await canvasAdapter().getSchedule({ startDate: start, endDate: end, includeAssignments: false });
      const records = prioritize(result.data, item => item.title, item => item.startAt, () => false, () => false,
        item => Date.parse(item.endAt || item.startAt || '') <= input.now.getTime()).map(item => ({ courseId: item.courseId, course: item.course, title: item.title,
        startAt: item.startAt, startAtLocal: item.startAtLocal, endAt: item.endAt, url: item.url, description: item.description.slice(0, 250) }));
      return { ...boundedEvidence(records, 40, 4_500), warnings: result.warnings };
    }),
    readSource('googleCalendar', Boolean(input.calendar), async () => {
      const limit = examQuestion ? 250 : 100;
      const events = await new GoogleCalendarAdapter(input.calendar!, { fetch: input.calendarFetch }).listEvents({ timeMin: start, timeMax: end, maxResultsPerCalendar: limit });
      const bounded = boundedEvidence(prioritize(events, item => item.summary, item => item.start.dateTime || item.start.date, () => false,
        item => item.end.date ? item.end.date > today : Date.parse(item.end.dateTime || '') > input.now.getTime(),
        item => item.end.date ? item.end.date <= today : Date.parse(item.end.dateTime || item.start.dateTime || '') <= input.now.getTime()).map(event => localCalendarEvidence(event, timeZone)), 60, 7_000);
      return { events: bounded.data, omitted: bounded.omitted, coverage: `Bounded window; at most ${limit} events per calendar before prioritization. An event cap may omit later items. Calendar records do not verify submission state. All-day end dates are exclusive.` };
    }),
  ]);
  return { checkedAt: input.now.toISOString(), window: { start, end }, sources };
}

export function compactCourseIndex(courses: Array<Record<string, unknown>>) {
  return courses.map(course => ({
    courseId: course.courseId, courseName: course.courseName, courseCode: course.courseCode,
    termName: course.termName, courseUrl: course.courseUrl, teachers: course.teachers,
    syllabus: course.syllabus, externalSystems: course.externalSystems, initializedAt: course.initializedAt,
  }));
}

export function relevantMemories<T extends { content: string; pinned?: boolean }>(memories: T[], message: string, limit = 20) {
  const words = message.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return memories.map((memory, index) => ({ memory, index, score: (memory.pinned ? 100 : 0) + words.reduce((score, word) => score + (memory.content.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(item => item.memory);
}

/** Keep recent complete messages; the current request is never truncated. */
export function boundedHistory<T extends { role: string; content: string | null }>(messages: T[], maxChars = 24_000) {
  let start = messages.length;
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const size = messages[index]!.content?.length || 0;
    if (index !== messages.length - 1 && characters + size > maxChars) break;
    start = index; characters += size;
  }
  while (start < messages.length - 1 && messages[start]?.role === 'assistant') start++;
  return { messages: messages.slice(start), omitted: start };
}

/** Preserve whole paragraphs and nearby context; omitted text is never claimed inspected. */
export function documentEvidence(text: string, query: string, maxChars = 16_000) {
  if (text.length <= maxChars) return { text, excerpted: false, totalCharacters: text.length };
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter(word =>
    !['what', 'when', 'which', 'about', 'from', 'with', 'have', 'this', 'that', 'class', 'course', 'please', 'today', 'next', 'tell', 'saved', 'syllabus'].includes(word));
  const paragraphs = text.split(/\n+/).flatMap(value => value.length > 1_000 ? value.match(/[\s\S]{1,1000}/g) || [] : [value]).map(value => value.trim()).filter(Boolean);
  const ranked = paragraphs.map((paragraph, index) => ({ index, score: words.reduce((score, word) => score + (paragraph.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Set<number>();
  let size = 0;
  const include = (index: number) => {
    if (index < 0 || index >= paragraphs.length || selected.has(index)) return;
    if (size + paragraphs[index]!.length + 2 > maxChars) return;
    selected.add(index); size += paragraphs[index]!.length + 2;
  };
  for (const item of ranked) { include(item.index); include(item.index - 1); include(item.index + 1); }
  for (let i = 0; i < Math.min(paragraphs.length, 5); i++) include(i);
  for (let i = 0; i < paragraphs.length && size < maxChars; i++) include(i);
  return { text: [...selected].sort((a, b) => a - b).map(index => paragraphs[index]).join('\n\n'), excerpted: true, totalCharacters: text.length };
}
