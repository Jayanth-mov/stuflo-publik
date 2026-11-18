import { GoogleCalendarAdapter, GoogleCalendarError, type GoogleTokens } from '@stuflo/calendar';
import type { StufloEnv } from '../env';
import { connectGoogleForStudent, GOOGLE_CALENDAR_SCOPES } from './google-connections';
import { openDatabase } from './database';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export type GoogleOAuthErrorCode =
  | 'authorization'
  | 'calendar_account'
  | 'calendar_api'
  | 'configuration'
  | 'google_unavailable'
  | 'scopes'
  | 'session'
  | 'state'
  | 'storage'
  | 'unknown';

export function googleOAuthErrorCode(error: unknown): GoogleOAuthErrorCode {
  if (error instanceof GoogleCalendarError) {
    if (error.code === 'permission_denied') return 'calendar_api';
    if (error.code === 'session_expired' || error.code === 'not_connected') return 'authorization';
    if (error.code === 'rate_limited' || error.code === 'upstream_error') return 'google_unavailable';
  }
  const message = error instanceof Error ? error.message : '';
  if (/state has expired|invalid google oauth state/i.test(message)) return 'state';
  if (/session does not match/i.test(message)) return 'session';
  if (/oauth is not configured|credentials are not configured/i.test(message)) return 'configuration';
  if (/reusable calendar authorization/i.test(message)) return 'authorization';
  if (/required calendar scopes|exactly the approved/i.test(message)) return 'scopes';
  if (/primary account calendar/i.test(message)) return 'calendar_account';
  if (/student does not exist|cookie_encryption_keys|encryption_key/i.test(message)) return 'storage';
  return 'unknown';
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function configuration(env: StufloEnv) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_STATE_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    stateSecret: env.GOOGLE_OAUTH_STATE_SECRET,
    redirectUri: `${env.API_ORIGIN || 'https://api.stuflo.com'}/v1/connections/google/callback`,
  };
}

async function signState(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))),
  );
}

async function safeStateEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

export async function createGoogleAuthorizationUrl(env: StufloEnv, studentKey: string) {
  const config = configuration(env);
  const statePayload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        studentKey,
        exp: Math.floor(Date.now() / 1_000) + 10 * 60,
        nonce: crypto.randomUUID(),
      }),
    ),
  );
  const signature = await signState(statePayload, config.stateSecret);
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    state: `${statePayload}.${signature}`,
  });
  return `${AUTH_ENDPOINT}?${query}`;
}

export async function verifyGoogleState(env: StufloEnv, state: string) {
  const config = configuration(env);
  const [payload, signature, ...extra] = state.split('.');
  if (!payload || !signature || extra.length || !(await safeStateEqual(signature, await signState(payload, config.stateSecret)))) {
    throw new Error('Invalid Google OAuth state.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    throw new Error('Invalid Google OAuth state.');
  }
  const candidate = decoded as { studentKey?: unknown; exp?: unknown };
  if (
    typeof candidate.studentKey !== 'string' ||
    !candidate.studentKey.startsWith('student_') ||
    !Number.isSafeInteger(candidate.exp) ||
    Number(candidate.exp) < Math.floor(Date.now() / 1_000)
  ) {
    throw new Error('Google OAuth state has expired.');
  }
  return { studentKey: candidate.studentKey };
}

export async function completeGoogleAuthorization(
  env: StufloEnv,
  input: { code: string; state: string; authenticatedStudentKey: string },
  fetcher: typeof fetch = fetch,
) {
  const verifiedState = await verifyGoogleState(env, input.state);
  if (verifiedState.studentKey !== input.authenticatedStudentKey) {
    throw new Error('Google OAuth session does not match the signed-in student.');
  }
  const config = configuration(env);
  let response: Response;
  try {
    response = await fetcher(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new GoogleCalendarError('upstream_error', 'Google authorization could not be reached.', undefined, { cause: error });
  }
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    if (response.status === 429 || response.status >= 500) {
      throw new GoogleCalendarError(response.status === 429 ? 'rate_limited' : 'upstream_error', 'Google authorization is temporarily unavailable.', response.status);
    }
    throw new Error(payload.error_description || 'Google did not return a reusable Calendar authorization.');
  }
  const grantedScopes = new Set((payload.scope || '').split(/\s+/).filter(Boolean));
  if (!GOOGLE_CALENDAR_SCOPES.every((scope) => grantedScopes.has(scope))) {
    throw new Error('Google did not grant the required Calendar scopes.');
  }
  const tokens: GoogleTokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(1, Number.isFinite(payload.expires_in) ? payload.expires_in! : 3_600) * 1_000).toISOString(),
  };
  let currentTokens = tokens;
  const adapter = new GoogleCalendarAdapter({
    tokens,
    oauth: { clientId: config.clientId, clientSecret: config.clientSecret },
    onTokensUpdated: async (updated) => { currentTokens = updated; },
  }, { fetch: fetcher });
  const calendars = await adapter.listCalendars();
  const googleEmail = calendars.find((calendar) => calendar.primary)?.id;
  if (!googleEmail || !googleEmail.includes('@')) {
    throw new Error('Google Calendar did not return a primary account calendar.');
  }
  const opened = openDatabase(env);
  try {
    return await connectGoogleForStudent(opened.db, env, {
      studentKey: input.authenticatedStudentKey,
      googleEmail,
      tokens: currentTokens,
      scopes: [...GOOGLE_CALENDAR_SCOPES],
    }, { fetch: fetcher, verifiedCalendars: calendars });
  } finally {
    await opened.close();
  }
}
