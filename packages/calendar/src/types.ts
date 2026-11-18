export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleCalendarConnection {
  tokens: GoogleTokens;
  oauth: GoogleOAuthConfig;
  onTokensUpdated?: (tokens: GoogleTokens) => Promise<void>;
  onAuthorizationExpired?: () => Promise<void>;
}

export interface CalendarSummary {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  timeZone: string | null;
  writable: boolean;
}

export interface EventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface EventReminder {
  method: 'email' | 'popup';
  minutes: number;
}

export interface EventReminders {
  useDefault: boolean;
  overrides: EventReminder[];
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  calendarName: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  status: string;
  start: EventDateTime;
  end: EventDateTime;
  reminders: EventReminders | null;
  htmlLink: string | null;
  updatedAt: string | null;
}

export interface ListEventsQuery {
  calendarIds?: string[];
  timeMin: string;
  timeMax: string;
  maxResultsPerCalendar?: number;
}

export interface FreeBusyCalendar {
  calendarId: string;
  busy: Array<{ start: string; end: string }>;
  errors: Array<{ reason?: string; domain?: string }>;
}

export interface EventInput {
  summary: string;
  description?: string;
  location?: string;
  start: EventDateTime;
  end: EventDateTime;
  reminderMinutesBefore?: number[];
  stufloId?: string;
  /** Server-generated key for one authorized creation; stable across retries. */
  idempotencyKey?: string;
}

export interface UpdateEventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  reminderMinutesBefore?: number[];
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
