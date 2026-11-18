import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StufloEnv } from '../src/env';

const mocks = vi.hoisted(() => ({ save: vi.fn(), close: vi.fn() }));
vi.mock('../src/services/google-connections', () => ({
  connectGoogleForStudent: mocks.save,
  GOOGLE_CALENDAR_SCOPES: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
import { completeGoogleAuthorization, createGoogleAuthorizationUrl, googleOAuthErrorCode } from '../src/services/google-oauth';

const env = {
  GOOGLE_CLIENT_ID: 'synthetic-id', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  GOOGLE_OAUTH_STATE_SECRET: 'synthetic-state-secret-long-enough-for-tests', API_ORIGIN: 'https://api.stuflo.com',
} as StufloEnv;
const scopes = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
async function input() {
  const url = new URL(await createGoogleAuthorizationUrl(env, 'student_test'));
  return { code: 'synthetic-code', state: url.searchParams.get('state')!, authenticatedStudentKey: 'student_test' };
}
beforeEach(() => { vi.clearAllMocks(); });

describe('Google OAuth callback acceptance', () => {
  it('verifies the primary account and calendars once before saving encrypted reusable authorization', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3_600, scope: scopes }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'student@example.com', primary: true, accessRole: 'owner' }] }));
    await completeGoogleAuthorization(env, await input(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledWith({}, env,
      expect.objectContaining({ studentKey: 'student_test', googleEmail: 'student@example.com', tokens: expect.objectContaining({ refreshToken: 'synthetic-refresh' }) }),
      expect.objectContaining({ fetch: fetcher, verifiedCalendars: [expect.objectContaining({ id: 'student@example.com' })] }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('does not exchange a code signed for another student', async () => {
    const fetcher = vi.fn();
    await expect(completeGoogleAuthorization(env, { ...await input(), authenticatedStudentKey: 'student_other' }, fetcher)).rejects.toThrow('does not match');
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('keeps old authorization intact if required scopes were not approved', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ access_token: 'access', refresh_token: 'refresh', scope: 'https://www.googleapis.com/auth/calendar.readonly' }));
    await expect(completeGoogleAuthorization(env, await input(), fetcher)).rejects.toThrow('required Calendar scopes');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('does not replace a reusable connection with an access token that cannot refresh', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ access_token: 'access', scope: scopes }));
    await expect(completeGoogleAuthorization(env, await input(), fetcher)).rejects.toThrow('reusable Calendar authorization');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects an account response that has no primary email calendar', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'access', refresh_token: 'refresh', scope: scopes }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'shared-calendar', accessRole: 'reader' }] }));
    await expect(completeGoogleAuthorization(env, await input(), fetcher)).rejects.toThrow('primary account calendar');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('maps token endpoint outages to a retryable connection result without replacing saved authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
    let failure: unknown;
    try { await completeGoogleAuthorization(env, await input(), fetcher); } catch (error) { failure = error; }
    expect(googleOAuthErrorCode(failure)).toBe('google_unavailable');
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
