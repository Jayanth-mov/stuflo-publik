import { GoogleCalendarAdapter, GoogleCalendarError, type CalendarSummary, type FetchLike, type GoogleCalendarConnection, type GoogleTokens } from '@stuflo/calendar';
import { WebCryptoKeyring, type EncryptedEnvelope } from '@stuflo/crypto';
import {
  getGoogleConnectionByStudentKey,
  getStudentByKey,
  deleteGoogleConnection,
  markGoogleConnectionExpired,
  updateGoogleTokens,
  upsertGoogleConnection,
  type StufloDatabase,
} from '@stuflo/db';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
] as const;

function keyring(env: StufloEnv): WebCryptoKeyring {
  if (!env.COOKIE_ENCRYPTION_KEYS) throw new Error('COOKIE_ENCRYPTION_KEYS is not configured.');
  return WebCryptoKeyring.fromJson(env.COOKIE_ENCRYPTION_KEYS);
}

function activeKeyId(env: StufloEnv): string {
  if (!env.ACTIVE_COOKIE_ENCRYPTION_KEY_ID) {
    throw new Error('ACTIVE_COOKIE_ENCRYPTION_KEY_ID is not configured.');
  }
  return env.ACTIVE_COOKIE_ENCRYPTION_KEY_ID;
}

function oauth(env: StufloEnv) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth credentials are not configured.');
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

function validateScopes(scopes: string[]): string[] {
  const normalized = [...new Set(scopes)];
  if (
    normalized.length !== GOOGLE_CALENDAR_SCOPES.length ||
    !GOOGLE_CALENDAR_SCOPES.every((scope) => normalized.includes(scope))
  ) {
    throw new Error('Google Calendar must use exactly the approved readonly and events scopes.');
  }
  return normalized;
}

export async function connectGoogleForStudent(
  db: StufloDatabase,
  env: StufloEnv,
  input: { studentKey: string; googleEmail: string; tokens: GoogleTokens; scopes: string[] },
  options: { fetch?: FetchLike; verifiedCalendars?: CalendarSummary[] } = {},
) {
  const student = await getStudentByKey(db, input.studentKey);
  if (!student) throw new Error('Student does not exist in Postgres.');
  const scopes = validateScopes(input.scopes);
  let currentTokens = { ...input.tokens };
  const adapter = new GoogleCalendarAdapter({
    tokens: currentTokens,
    oauth: oauth(env),
    onTokensUpdated: async (tokens) => {
      currentTokens = tokens;
    },
  }, { fetch: options.fetch });
  const calendars = options.verifiedCalendars ?? await adapter.listCalendars();
  const encryptedTokens = await keyring(env).encryptJson(currentTokens, activeKeyId(env));
  const connection = await upsertGoogleConnection(db, {
    studentId: student.id,
    googleEmail: input.googleEmail.trim().toLowerCase(),
    encryptedTokens,
    encryptionVersion: encryptedTokens.v,
    scopes,
    lastRefreshedAt: currentTokens.accessToken !== input.tokens.accessToken ? new Date() : null,
  });
  return { connection, calendarCount: calendars.length };
}

export async function disconnectGoogleForStudent(db: StufloDatabase, studentKey: string) {
  const student = await getStudentByKey(db, studentKey);
  if (student) await deleteGoogleConnection(db, student.id);
  // Google token revocation removes every scope in the OAuth project, including
  // unrelated grants. Disconnect only removes StuFlo's stored Calendar access.
  return { connected: false };
}

export async function checkGoogleConnectionForStudent(
  db: StufloDatabase,
  env: StufloEnv,
  studentKey: string,
  verify = false,
  fetcher?: FetchLike,
) {
  const row = await getGoogleConnectionByStudentKey(db, studentKey, false);
  if (!row) return { connected: false, verificationStatus: 'not_connected' as const };
  const stored = {
    connected: true,
    googleEmail: row.googleEmail,
    scopes: row.scopes,
    connectedAt: row.connectedAt,
    lastRefreshedAt: row.lastRefreshedAt,
    verificationStatus: 'stored' as 'stored' | 'valid' | 'invalid' | 'unavailable',
  };
  if (row.status !== 'connected') return { ...stored, connected: false, verificationStatus: 'invalid' as const,
    reconnectRequired: true, message: 'Google Calendar authorization expired. Reconnect Google Calendar.' };
  if (!verify) return stored;
  try {
    const connection = await connectionFromRow(env, row);
    await new GoogleCalendarAdapter(connection, { fetch: fetcher }).listCalendars();
    return { ...stored, verificationStatus: 'valid' as const };
  } catch (error) {
    if (error instanceof GoogleCalendarError && (error.code === 'session_expired' || error.code === 'not_connected')) {
      if (error.code === 'not_connected') await markGoogleConnectionExpired(db, row.studentId, row.connectedAt);
      return { ...stored, connected: false, verificationStatus: 'invalid' as const, reconnectRequired: true,
        message: 'Google Calendar authorization expired. Reconnect Google Calendar.' };
    }
    return { ...stored, verificationStatus: 'unavailable' as const,
      message: 'Google Calendar could not be checked right now. Your connection is saved; try again shortly.' };
  }
}

async function connectionFromRow(env: StufloEnv, row: NonNullable<Awaited<ReturnType<typeof getGoogleConnectionByStudentKey>>>): Promise<GoogleCalendarConnection> {
  validateScopes(row.scopes);
  const tokens = await keyring(env).decryptJson<GoogleTokens>(row.encryptedTokens as EncryptedEnvelope);
  if (typeof tokens?.refreshToken !== 'string' || !tokens.refreshToken.trim()) throw new GoogleCalendarError('not_connected', 'Stored Google Calendar authorization is missing.');
  return {
    tokens,
    oauth: oauth(env),
    onTokensUpdated: async (updatedTokens) => {
      const encrypted = await keyring(env).encryptJson(updatedTokens, activeKeyId(env));
      const opened = openDatabase(env);
      try {
        await updateGoogleTokens(opened.db, row.studentId, encrypted, encrypted.v, row.connectedAt);
      } finally {
        await opened.close();
      }
    },
    onAuthorizationExpired: async () => {
      const opened = openDatabase(env);
      try {
        await markGoogleConnectionExpired(opened.db, row.studentId, row.connectedAt);
      } finally {
        await opened.close();
      }
    },
  };
}

export async function loadGoogleForStudent(
  env: StufloEnv,
  studentKey: string,
): Promise<GoogleCalendarConnection | undefined> {
  if (
    (!env.HYPERDRIVE && !env.DATABASE_URL) ||
    !env.COOKIE_ENCRYPTION_KEYS ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET
  ) {
    return undefined;
  }
  const { db, close } = openDatabase(env);
  let row: Awaited<ReturnType<typeof getGoogleConnectionByStudentKey>>;
  try {
    row = await getGoogleConnectionByStudentKey(db, studentKey);
  } finally {
    await close();
  }
  if (!row) return undefined;
  try {
    return await connectionFromRow(env, row);
  } catch (error) {
    if (!(error instanceof GoogleCalendarError) || error.code !== 'not_connected') throw error;
    const opened = openDatabase(env);
    try {
      await markGoogleConnectionExpired(opened.db, row.studentId, row.connectedAt);
    } finally {
      await opened.close();
    }
    return undefined;
  }
}
