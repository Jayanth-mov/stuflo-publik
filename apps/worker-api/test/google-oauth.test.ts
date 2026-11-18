import { describe, expect, it } from 'vitest';
import {
  createGoogleAuthorizationUrl,
  googleOAuthErrorCode,
  verifyGoogleState,
} from '../src/services/google-oauth';
import { GoogleCalendarError } from '@stuflo/calendar';
import type { StufloEnv } from '../src/env';

const env = {
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_OAUTH_STATE_SECRET: 'a-long-random-state-secret-for-tests',
  API_ORIGIN: 'https://api.stuflo.com',
} as StufloEnv;

describe('Google OAuth state', () => {
  it('binds the exact Calendar scopes and callback to a signed student state', async () => {
    const authorizationUrl = new URL(
      await createGoogleAuthorizationUrl(env, 'student_google_test'),
    );
    expect(authorizationUrl.origin).toBe('https://accounts.google.com');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'https://api.stuflo.com/v1/connections/google/callback',
    );
    expect(authorizationUrl.searchParams.get('scope')?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    const state = authorizationUrl.searchParams.get('state') || '';
    await expect(verifyGoogleState(env, state)).resolves.toEqual({
      studentKey: 'student_google_test',
    });
  });

  it('rejects tampered state', async () => {
    const authorizationUrl = new URL(
      await createGoogleAuthorizationUrl(env, 'student_google_test'),
    );
    const state = authorizationUrl.searchParams.get('state') || '';
    await expect(verifyGoogleState(env, `${state}x`)).rejects.toThrow('Invalid Google OAuth state');
  });

  it('maps callback failures to safe user-facing reason codes', () => {
    expect(
      googleOAuthErrorCode(
        new GoogleCalendarError('permission_denied', 'Calendar API is disabled.', 403),
      ),
    ).toBe('calendar_api');
    expect(googleOAuthErrorCode(new Error('Google OAuth session does not match the signed-in student.')))
      .toBe('session');
    expect(googleOAuthErrorCode(new Error('Unexpected database failure.'))).toBe('unknown');
  });
});
