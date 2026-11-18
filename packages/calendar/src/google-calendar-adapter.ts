import type {
  CalendarEvent,
  CalendarSummary,
  EventInput,
  FetchLike,
  FreeBusyCalendar,
  GoogleCalendarConnection,
  GoogleTokens,
  ListEventsQuery,
  UpdateEventInput,
} from './types';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const WRITABLE_ROLES = new Set(['writer', 'owner']);

interface CalendarListResponse {
  items?: Array<{
    id?: string;
    summary?: string;
    description?: string;
    primary?: boolean;
    accessRole?: string;
    timeZone?: string;
  }>;
  nextPageToken?: string;
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method?: string; minutes?: number }>;
  };
  htmlLink?: string;
  updated?: string;
}

interface EventListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

export class GoogleCalendarError extends Error {
  constructor(
    readonly code: 'not_connected' | 'session_expired' | 'permission_denied' | 'not_found' | 'rate_limited' | 'upstream_error' | 'invalid_response',
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GoogleCalendarError';
  }
}

export class GoogleCalendarAdapter {
  private tokens: GoogleTokens;
  private readonly connection: GoogleCalendarConnection;
  private readonly fetcher: FetchLike;
  private refreshInFlight?: Promise<void>;

  constructor(connection: GoogleCalendarConnection, options: { fetch?: FetchLike } = {}) {
    if (!connection.tokens.refreshToken) {
      throw new GoogleCalendarError('not_connected', 'Google Calendar is not connected.');
    }
    this.connection = connection;
    this.tokens = { ...connection.tokens };
    const fetcher = options.fetch ?? fetch;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const items: CalendarSummary[] = [];
    const seenIds = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > 10) throw new GoogleCalendarError('invalid_response', 'Calendar pagination exceeded 10 pages.');
      const query = new URLSearchParams({ maxResults: '250', showDeleted: 'false', showHidden: 'false' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await this.requestJson<CalendarListResponse>(
        `${CALENDAR_API}/users/me/calendarList?${query}`,
      );
      if (data.items !== undefined && !Array.isArray(data.items)) throw new GoogleCalendarError('invalid_response', 'Google Calendar returned an invalid calendar list.');
      for (const item of data.items || []) {
        if (!item.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        const accessRole = item.accessRole || 'reader';
        items.push({
          id: item.id,
          summary: item.summary || item.id,
          description: item.description || null,
          primary: item.primary === true,
          accessRole,
          timeZone: item.timeZone || null,
          writable: WRITABLE_ROLES.has(accessRole),
        });
      }
      pageToken = data.nextPageToken;
      if (pageToken && seenPageTokens.has(pageToken)) throw new GoogleCalendarError('invalid_response', 'Google Calendar repeated a calendar page.');
      if (pageToken) seenPageTokens.add(pageToken);
    } while (pageToken);
    return items;
  }

  async resolveCalendar(reference?: string, writable = true): Promise<CalendarSummary> {
    const calendars = await this.listCalendars();
    const candidates = writable ? calendars.filter((calendar) => calendar.writable) : calendars;
    if (!candidates.length) {
      throw new GoogleCalendarError(
        'not_found',
        writable ? 'The connected Google account has no writable calendars.' : 'No Google calendars were found.',
      );
    }

    const normalized = reference?.trim().toLocaleLowerCase();
    if (
      !normalized ||
      ['primary', 'default', 'my calendar', 'main', 'any', 'whichever', 'whatever is available', 'whichever is available'].includes(normalized)
    ) {
      return candidates.find((calendar) => calendar.primary) || candidates[0];
    }

    const idMatch = candidates.find((calendar) => calendar.id.toLocaleLowerCase() === normalized);
    if (idMatch) return idMatch;

    const nameMatches = candidates.filter(
      (calendar) => calendar.summary.trim().toLocaleLowerCase() === normalized,
    );
    if (nameMatches.length === 1) return nameMatches[0];
    if (nameMatches.length > 1) {
      throw new GoogleCalendarError(
        'not_found',
        `More than one Google calendar is named “${reference}”. Use its calendar ID instead.`,
      );
    }

    throw new GoogleCalendarError(
      'not_found',
      `The calendar “${reference}” was not found. Available ${writable ? 'writable ' : ''}calendars: ${candidates
        .map((calendar) => `${calendar.summary} (${calendar.id})`)
        .join(', ')}.`,
    );
  }

  async listEvents(query: ListEventsQuery): Promise<CalendarEvent[]> {
    validateWindow(query.timeMin, query.timeMax);
    const calendars = await this.listCalendars();
    const selected = query.calendarIds?.length
      ? calendars.filter((calendar) => query.calendarIds?.includes(calendar.id))
      : calendars.filter((calendar) => calendar.accessRole !== 'freeBusyReader');
    const requestedMax = query.maxResultsPerCalendar ?? 100;
    if (!Number.isFinite(requestedMax)) {
      throw new GoogleCalendarError('invalid_response', 'Calendar event limit must be a finite number.');
    }
    const maxResults = Math.max(1, Math.min(Math.floor(requestedMax), 2_500));
    const perCalendar = await mapConcurrent(selected, 5, async (calendar) => {
        const events: CalendarEvent[] = [];
        const seenIds = new Set<string>();
        const seenPageTokens = new Set<string>();
        let pageToken: string | undefined;
        let pages = 0;
        do {
          pages += 1;
          if (pages > 10) {
            throw new GoogleCalendarError('invalid_response', `Event pagination exceeded 10 pages for ${calendar.id}.`);
          }
          const params = new URLSearchParams({
            timeMin: query.timeMin,
            timeMax: query.timeMax,
            singleEvents: 'true',
            orderBy: 'startTime',
            showDeleted: 'false',
            maxResults: String(Math.min(maxResults, 2_500)),
          });
          if (pageToken) params.set('pageToken', pageToken);
          const data = await this.requestJson<EventListResponse>(
            `${CALENDAR_API}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`,
          );
          if (data.items !== undefined && !Array.isArray(data.items)) throw new GoogleCalendarError('invalid_response', 'Google Calendar returned an invalid event list.');
          for (const event of data.items || []) {
            if (!event.id || !event.start || !event.end || event.status === 'cancelled' || seenIds.has(event.id)) continue;
            seenIds.add(event.id);
            events.push(this.normalizeEvent(event, calendar.id, calendar.summary, calendar.timeZone));
            if (events.length >= maxResults) break;
          }
          pageToken = events.length >= maxResults ? undefined : data.nextPageToken;
          if (pageToken && seenPageTokens.has(pageToken)) throw new GoogleCalendarError('invalid_response', 'Google Calendar repeated an event page.');
          if (pageToken) seenPageTokens.add(pageToken);
        } while (pageToken);
        return events;
      });
    return perCalendar.flat().sort((left, right) => eventStart(left) - eventStart(right));
  }

  async freeBusy(input: { calendarIds: string[]; timeMin: string; timeMax: string; timeZone?: string }): Promise<FreeBusyCalendar[]> {
    validateWindow(input.timeMin, input.timeMax);
    const data = await this.requestJson<{
      calendars?: Record<
        string,
        { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string; domain?: string }> }
      >;
    }>(`${CALENDAR_API}/freeBusy`, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        items: input.calendarIds.slice(0, 50).map((id) => ({ id })),
      }),
    });
    return input.calendarIds.slice(0, 50).map((calendarId) => {
      const calendar = data.calendars?.[calendarId];
      return {
        calendarId,
        busy: (calendar?.busy || []).filter(
          (period): period is { start: string; end: string } =>
            typeof period.start === 'string' && typeof period.end === 'string',
        ),
        errors: calendar?.errors || [],
      };
    });
  }

  async createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
    // Google accepts base32hex event IDs. SHA-256 hex is within that alphabet,
    // and binds every retry of this authorized operation to the same event.
    const eventId = input.idempotencyKey ? await creationEventId(input.idempotencyKey) : undefined;
    let created: GoogleEvent;
    try {
      created = await this.requestJson<GoogleEvent>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(eventId ? { id: eventId } : {}),
          summary: input.summary,
          description: input.description,
          location: input.location,
          start: input.start,
          end: input.end,
          ...(input.reminderMinutesBefore
            ? { reminders: googleReminders(input.reminderMinutesBefore) }
            : {}),
          ...(input.stufloId
            ? { extendedProperties: { private: { stufloId: input.stufloId } } }
            : {}),
        }),
      },
      );
    } catch (error) {
      const ambiguousWrite = error instanceof GoogleCalendarError && (
        error.status === 409 || (error.code === 'upstream_error' && (!error.status || error.status >= 500)) ||
        (error.code === 'invalid_response' && error.status === 200)
      );
      if (!eventId || !ambiguousWrite) throw error;
      // A conflict or lost POST response can mean the original insert succeeded.
      // Only accept the existing event when its persisted requested fields match.
      try {
        return await this.verifyEvent(calendarId, eventId, input);
      } catch (verificationError) {
        if (error.status === 409) throw verificationError;
        throw error;
      }
    }
    if (!created.id) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar did not return the created event ID.');
    }
    return this.verifyEvent(calendarId, created.id, input);
  }

  async updateEvent(calendarId: string, eventId: string, input: UpdateEventInput): Promise<CalendarEvent> {
    const body = Object.fromEntries(
      Object.entries({
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        ...(input.reminderMinutesBefore
          ? { reminders: googleReminders(input.reminderMinutesBefore) }
          : {}),
      }).filter(([, value]) => value !== undefined),
    );
    if (!Object.keys(body).length) {
      throw new GoogleCalendarError('invalid_response', 'No event changes were supplied.');
    }
    await this.requestJson<GoogleEvent>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return this.verifyEvent(calendarId, eventId, input);
  }

  async moveEvent(sourceCalendarId: string, eventId: string, destinationCalendarId: string): Promise<CalendarEvent> {
    const params = new URLSearchParams({ destination: destinationCalendarId, sendUpdates: 'none' });
    const event = await this.requestJson<GoogleEvent>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(sourceCalendarId)}/events/${encodeURIComponent(eventId)}/move?${params}`,
      { method: 'POST', body: '{}' },
    );
    return this.normalizeEvent(event, destinationCalendarId, null);
  }

  private async requestJson<T>(url: string, init: RequestInit = {}, retry = true, transientRetry = true): Promise<T> {
    await this.ensureAccessToken();
    const requestedAccessToken = this.tokens.accessToken;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        signal: init.signal || AbortSignal.timeout(12_000),
        headers: {
          authorization: `Bearer ${requestedAccessToken}`,
          'content-type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      if (transientRetry && (!init.method || init.method === 'GET')) {
        return this.requestJson<T>(url, init, retry, false);
      }
      throw new GoogleCalendarError('upstream_error', 'Google Calendar could not be reached.', undefined, { cause: error });
    }
    if (response.status === 401 && retry) {
      if (this.tokens.accessToken === requestedAccessToken) await this.refreshAccessToken();
      return this.requestJson<T>(url, init, false, transientRetry);
    }
    if (transientRetry && (!init.method || init.method === 'GET') && (response.status === 429 || response.status >= 500)) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(100, retryAfter * 1_000 || 100))));
      return this.requestJson<T>(url, init, retry, false);
    }
    if (response.status === 401) await this.connection.onAuthorizationExpired?.();
    if (!response.ok) throw await this.errorFromResponse(response);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar returned invalid JSON.', response.status, {
        cause: error,
      });
    }
  }

  private async verifyEvent(
    calendarId: string,
    eventId: string,
    expected: EventInput | UpdateEventInput,
  ): Promise<CalendarEvent> {
    const persisted = await this.requestJson<GoogleEvent>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    const event = this.normalizeEvent(persisted, calendarId, null);
    if (event.status === 'cancelled') {
      throw new GoogleCalendarError('invalid_response', 'The Google Calendar event was deleted; this creation cannot be reused.');
    }
    if (expected.summary !== undefined && event.summary !== expected.summary) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar did not persist the requested event title.');
    }
    if (expected.description !== undefined && event.description !== (expected.description || null)) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar did not persist the requested event details.');
    }
    if (expected.location !== undefined && event.location !== (expected.location || null)) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar did not persist the requested event location.');
    }
    if (expected.start && !dateTimeContains(event.start, expected.start)) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar did not persist the requested start time.');
    }
    if (expected.end && !dateTimeContains(event.end, expected.end)) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar did not persist the requested end time.');
    }
    if (expected.reminderMinutesBefore) {
      const actual = (event.reminders?.overrides || []).map((reminder) => reminder.minutes).sort((a, b) => a - b);
      const requested = [...new Set(expected.reminderMinutesBefore)].sort((a, b) => a - b);
      if (JSON.stringify(actual) !== JSON.stringify(requested)) {
        throw new GoogleCalendarError('invalid_response', 'Google Calendar did not persist the requested reminders.');
      }
    }
    return event;
  }

  private async ensureAccessToken(): Promise<void> {
    const expiresAt = this.tokens.expiresAt ? new Date(this.tokens.expiresAt).getTime() : 0;
    if (!this.tokens.accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
      await this.refreshAccessToken();
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performTokenRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async performTokenRefresh(): Promise<void> {
    const body = new URLSearchParams({
      client_id: this.connection.oauth.clientId,
      client_secret: this.connection.oauth.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
    });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetcher(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(12_000),
        });
      } catch (error) {
        if (attempt === 0) continue;
        throw new GoogleCalendarError('upstream_error', 'Google Calendar authorization could not be reached.', undefined, { cause: error });
      }
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      break;
    }
    if (!response) throw new GoogleCalendarError('upstream_error', 'Google Calendar authorization could not be reached.');
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) {
      const expired = payload.error === 'invalid_grant';
      if (expired) await this.connection.onAuthorizationExpired?.();
      throw new GoogleCalendarError(
        expired ? 'session_expired' : response.status === 429 ? 'rate_limited' : 'upstream_error',
        expired ? 'Google Calendar authorization expired. Reconnect Google Calendar.' : 'Google Calendar authorization is temporarily unavailable.',
        response.status,
      );
    }
    this.tokens = {
      ...this.tokens,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || this.tokens.refreshToken,
      expiresAt: new Date(Date.now() + Math.max(1, Number.isFinite(payload.expires_in) ? payload.expires_in! : 3_600) * 1_000).toISOString(),
    };
    await this.connection.onTokensUpdated?.({ ...this.tokens });
  }

  private async errorFromResponse(response: Response): Promise<GoogleCalendarError> {
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = payload.error?.message || `Google Calendar returned HTTP ${response.status}.`;
    if (response.status === 401) return new GoogleCalendarError('session_expired', message, response.status);
    if (response.status === 403) return new GoogleCalendarError('permission_denied', message, response.status);
    if (response.status === 404) return new GoogleCalendarError('not_found', message, response.status);
    if (response.status === 429) return new GoogleCalendarError('rate_limited', message, response.status);
    return new GoogleCalendarError('upstream_error', message, response.status);
  }

  private normalizeEvent(event: GoogleEvent, calendarId: string, calendarName: string | null, calendarTimeZone?: string | null): CalendarEvent {
    if (!event.id || !event.start || !event.end) {
      throw new GoogleCalendarError('invalid_response', 'Google Calendar returned an incomplete event.');
    }
    return {
      id: event.id,
      calendarId,
      calendarName,
      summary: event.summary || '(untitled)',
      description: event.description || null,
      location: event.location || null,
      status: event.status || 'confirmed',
      start: { ...event.start, ...(event.start.timeZone || !calendarTimeZone ? {} : { timeZone: calendarTimeZone }) },
      end: { ...event.end, ...(event.end.timeZone || !calendarTimeZone ? {} : { timeZone: calendarTimeZone }) },
      reminders: event.reminders
        ? {
            useDefault: event.reminders.useDefault === true,
            overrides: (event.reminders.overrides || []).flatMap((reminder) =>
              (reminder.method === 'email' || reminder.method === 'popup') &&
              typeof reminder.minutes === 'number'
                ? [{ method: reminder.method, minutes: reminder.minutes }]
                : [],
            ),
          }
        : null,
      htmlLink: event.htmlLink || null,
      updatedAt: event.updated || null,
    };
  }
}

async function creationEventId(key: string): Promise<string> {
  if (!key || key.length > 2_000) throw new GoogleCalendarError('invalid_response', 'Calendar creation key is invalid.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return 'stuflo' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function googleReminders(minutesBefore: number[]) {
  const minutes = [...new Set(minutesBefore)]
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 40_320)
    .slice(0, 5);
  if (minutes.length !== minutesBefore.length) {
    throw new GoogleCalendarError(
      'invalid_response',
      'Calendar reminders must be unique whole minutes between 0 and 40,320, with at most five reminders.',
    );
  }
  return {
    useDefault: false,
    overrides: minutes.map((minutes) => ({ method: 'popup', minutes })),
  };
}

function dateTimeContains(actual: EventDateTimeLike, expected: EventDateTimeLike): boolean {
  const sameTime = !expected.dateTime || actual.dateTime === expected.dateTime ||
    (Boolean(actual.dateTime) && Number.isFinite(Date.parse(expected.dateTime)) && Date.parse(actual.dateTime!) === Date.parse(expected.dateTime));
  return (!expected.date || actual.date === expected.date) &&
    sameTime &&
    (!expected.timeZone || actual.timeZone === expected.timeZone || (!actual.timeZone && Boolean(expected.dateTime) && sameTime));
}

type EventDateTimeLike = { date?: string; dateTime?: string; timeZone?: string };

function eventStart(event: CalendarEvent): number {
  if (event.start.dateTime) return Date.parse(event.start.dateTime);
  const midnight = Date.parse(`${event.start.date}T00:00:00Z`);
  if (!event.start.timeZone || !Number.isFinite(midnight)) return midnight;
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: event.start.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    let instant = midnight;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
      const displayed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      instant += midnight - displayed;
    }
    return instant;
  } catch {
    return midnight;
  }
}

function validateWindow(timeMin: string, timeMax: string): void {
  const withOffset = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!withOffset.test(timeMin) || !withOffset.test(timeMax) || !Number.isFinite(Date.parse(timeMin)) ||
      !Number.isFinite(Date.parse(timeMax)) || Date.parse(timeMin) >= Date.parse(timeMax)) {
    throw new GoogleCalendarError('invalid_response', 'Calendar time bounds must include timezone offsets and an end after the start.');
  }
}

async function mapConcurrent<T, U>(items: T[], limit: number, run: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  }));
  return results;
}
