import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';

const mocks = vi.hoisted(() => ({ issue: vi.fn(), invalidate: vi.fn(), redeem: vi.fn(), close: vi.fn(), usage: vi.fn() }));
vi.mock('@stuflo/db', () => ({ issueEmailChallenge: mocks.issue, invalidateEmailChallenge: mocks.invalidate,
  redeemEmailChallenge: mocks.redeem, signInGoogleIdentity: vi.fn() }));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
vi.mock('../src/services/usage', () => ({ getUsageStatus: mocks.usage }));
import { requestEmailCode, verifyEmailCode, startGoogleSignIn, finishGoogleSignIn, googleIdentity, authOriginAllowed, loginDestination } from '../src/services/passwordless';
import type { StufloEnv } from '../src/env';

const env = { AUTH_SECRET: 'test-secret-'.repeat(4), RESEND_API_KEY: 'test', APP_ORIGIN: 'https://app.stuflo.com',
  API_ORIGIN: 'https://api.stuflo.com', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' } as StufloEnv;

describe('email codes and Google sign-in', () => {
  it('preserves the trial through signed Google state and failed-login retries', async () => {
    const response = await startGoogleSignIn(env, new Request('https://api.stuflo.com/v1/auth/google/start?interval=yearly&trial=1'));
    const googleUrl = new URL(response.headers.get('location')!);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const { payload } = await jwtVerify(cookie.split('=')[1], new TextEncoder().encode(env.AUTH_SECRET!));
    expect(payload.destination).toBe('/auth/checkout?interval=yearly&trial=1');
    const failed = await finishGoogleSignIn(env, new Request(`https://api.stuflo.com/v1/connections/google/callback?state=${googleUrl.searchParams.get('state')}&error=access_denied`, { headers: { cookie } }));
    expect(failed.headers.get('location')).toBe('https://app.stuflo.com/auth/signin?interval=yearly&trial=1&google=cancelled');
    expect(loginDestination('monthly', '1')).toBe('/auth/checkout?interval=monthly&trial=1');
    expect(loginDestination('monthly', '999')).toBe('/auth/checkout?interval=monthly');
    expect(loginDestination('https://evil.com', '1')).toBe('/dashboard');
  });
  beforeEach(() => { vi.clearAllMocks(); mocks.issue.mockResolvedValue(true); });
  it('issues a challenge for a new email without requiring a prior account', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'email-id' }));
    expect(await requestEmailCode(env, ' NEW@Example.com ', fetcher)).toMatchObject({ status: 'sent', challengeId: expect.any(String) });
    expect(mocks.issue).toHaveBeenCalledWith({}, expect.objectContaining({ email: 'new@example.com', codeHash: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  });
  it('does not send on rate limit or invalid email', async () => {
    const fetcher = vi.fn(); mocks.issue.mockResolvedValue(false);
    expect(await requestEmailCode(env, 'a@b.com', fetcher)).toEqual({ status: 'rate_limited' });
    expect(await requestEmailCode(env, 'bad', fetcher)).toEqual({ status: 'invalid_email' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('invalidates an undelivered code without exposing provider errors', async () => {
    await expect(requestEmailCode(env, 'a@b.com', vi.fn().mockResolvedValue(Response.json({}, { status: 403 })))).rejects.toThrow('could not be delivered');
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('issues a session only after redemption and ensures the monthly allowance', async () => {
    mocks.redeem.mockResolvedValue({ studentKey: 'student_test', plan: 'free' });
    const result = await verifyEmailCode(env, new Request('https://api.stuflo.com'), { email: 'a@b.com', code: '123456', challengeId: crypto.randomUUID() });
    expect(result?.cookie).toContain('HttpOnly; Secure');
    expect(mocks.usage).toHaveBeenCalledWith(env, 'student_test');
    mocks.redeem.mockResolvedValue(null);
    expect(await verifyEmailCode(env, new Request('https://api.stuflo.com'), { email: 'a@b.com', code: '123456', challengeId: crypto.randomUUID() })).toBeNull();
  });
  it('binds Google login to a browser, nonce, PKCE and an allowlisted destination', async () => {
    const response = await startGoogleSignIn(env, new Request('https://api.stuflo.com/v1/auth/google/start?interval=yearly&next=https://evil.com'));
    const url = new URL(response.headers.get('location')!);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.stuflo.com/v1/connections/google/callback');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('__Host-stuflo.login='); expect(cookie).not.toContain('Domain=');
    const token = cookie.split(';')[0].split('=')[1];
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.AUTH_SECRET!));
    expect(payload.destination).toBe('/auth/checkout?interval=yearly');
    expect(payload.state).toBe(url.searchParams.get('state'));
    expect(payload.nonce).toBe(url.searchParams.get('nonce'));
    expect(loginDestination('https://evil.com')).toBe('/dashboard');
  });
  it('rejects callbacks with missing or forged browser state before exchanging credentials', async () => {
    const response = await finishGoogleSignIn(env, new Request('https://api.stuflo.com/v1/connections/google/callback?state=login.fake&code=attacker'));
    expect(response.headers.get('location')).toBe('https://app.stuflo.com/auth/signin?google=error');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('requires a matching nonce and verified email, with extra proof for third-party addresses', () => {
    const payload = { sub: '123', email: 'a@gmail.com', email_verified: true, nonce: 'nonce' };
    expect(googleIdentity(payload, 'nonce').emailAuthoritative).toBe(true);
    expect(googleIdentity({ ...payload, email: 'a@school.edu', hd: 'school.edu' }, 'nonce').emailAuthoritative).toBe(true);
    expect(googleIdentity({ ...payload, email: 'a@third-party.com' }, 'nonce').emailAuthoritative).toBe(false);
    expect(() => googleIdentity(payload, 'wrong')).toThrow();
    expect(() => googleIdentity({ ...payload, email_verified: false }, 'nonce')).toThrow();
  });
  it('rejects cross-site code submissions', () => {
    expect(authOriginAllowed(new Request('https://api.stuflo.com', { headers: { origin: 'https://evil.com' } }), env)).toBe(false);
    expect(authOriginAllowed(new Request('https://api.stuflo.com', { headers: { origin: env.APP_ORIGIN! } }), env)).toBe(true);
  });
});
