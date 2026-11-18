import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import { EMAIL_CODE_TTL_SECONDS, SESSION_TTL_SECONDS, generateEmailCode, generateOpaqueToken,
  hashEmailCode, hashOpaqueToken, normalizeEmail, readCookie, sendEmailCode, serializeSessionCookie } from '@stuflo/auth';
import { issueEmailChallenge, invalidateEmailChallenge, redeemEmailChallenge, signInGoogleIdentity } from '@stuflo/db';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';
import { getUsageStatus } from './usage';

const OAUTH_COOKIE = '__Host-stuflo.login';
const LINK_COOKIE = '__Secure-stuflo.google-link';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secret(env: StufloEnv) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error('Authentication secret is not configured.');
  return env.AUTH_SECRET;
}

export function loginDestination(interval: unknown, trial?: unknown) {
  return interval === 'monthly' || interval === 'yearly'
    ? `/auth/checkout?interval=${interval}${trial === '1' ? '&trial=1' : ''}` : '/dashboard';
}

export function authOriginAllowed(request: Request, env: StufloEnv) {
  const origin = request.headers.get('origin');
  return origin === (env.APP_ORIGIN || 'https://app.stuflo.com') ||
    origin === (env.API_ORIGIN || 'https://api.stuflo.com');
}

async function signContext(env: StufloEnv, purpose: string, payload: JWTPayload) {
  return new SignJWT({ ...payload, purpose }).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime('10m').setIssuer('stuflo-auth')
    .sign(new TextEncoder().encode(secret(env)));
}

async function readContext(env: StufloEnv, request: Request, name: string, purpose: string) {
  try {
    const token = readCookie(request, name);
    if (!token) return null;
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret(env)),
      { algorithms: ['HS256'], issuer: 'stuflo-auth' });
    return payload.purpose === purpose ? payload : null;
  } catch { return null; }
}

function contextCookie(name: string, value: string, requestUrl: string, clear = false) {
  const hostname = new URL(requestUrl).hostname;
  const domain = name === LINK_COOKIE && (hostname === 'stuflo.com' || hostname.endsWith('.stuflo.com'))
    ? '; Domain=.stuflo.com' : '';
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : 600}${domain}`;
}

export async function pendingGoogleLink(env: StufloEnv, request: Request) {
  const payload = await readContext(env, request, LINK_COOKIE, 'google-link');
  return payload && typeof payload.email === 'string' && typeof payload.sub === 'string' ? payload : null;
}

export async function requestEmailCode(env: StufloEnv, rawEmail: unknown, fetcher: typeof fetch = fetch) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { status: 'invalid_email' as const };
  if (!env.RESEND_API_KEY) throw new Error('Email delivery is not configured.');
  const id = crypto.randomUUID();
  const code = generateEmailCode();
  const codeHash = await hashEmailCode(secret(env), id, email, code);
  const now = new Date();
  const opened = openDatabase(env);
  try {
    const issued = await issueEmailChallenge(opened.db, { id, email, codeHash, now,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_SECONDS * 1_000) });
    if (!issued) return { status: 'rate_limited' as const };
    try {
      await sendEmailCode({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM || 'Stu from StuFlo <stu@stuflo.com>',
        to: email, code, id }, fetcher);
    } catch (error) {
      await invalidateEmailChallenge(opened.db, id);
      throw error;
    }
    return { status: 'sent' as const, challengeId: id };
  } finally { await opened.close(); }
}

export async function verifyEmailCode(env: StufloEnv, request: Request, input: {
  email?: unknown; code?: unknown; challengeId?: unknown;
}) {
  const email = normalizeEmail(input.email);
  if (!email || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code) ||
    typeof input.challengeId !== 'string' || !UUID.test(input.challengeId)) return null;
  const pending = await pendingGoogleLink(env, request);
  const sessionToken = generateOpaqueToken();
  const opened = openDatabase(env);
  let session;
  try {
    session = await redeemEmailChallenge(opened.db, { id: input.challengeId, email,
      codeHash: await hashEmailCode(secret(env), input.challengeId, email, input.code), now: new Date(),
      sessionTokenHash: await hashOpaqueToken(sessionToken),
      sessionExpiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1_000),
      ...(pending?.email === email ? { googleSubject: String(pending.sub) } : {}) });
  } finally { await opened.close(); }
  if (!session) return null;
  await getUsageStatus(env, session.studentKey);
  return { session, cookie: serializeSessionCookie(sessionToken, request.url),
    clearLinkCookie: contextCookie(LINK_COOKIE, '', request.url, true) };
}

export async function startGoogleSignIn(env: StufloEnv, request: Request) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('Google sign-in is not configured.');
  const state = `login.${generateOpaqueToken()}`;
  const nonce = generateOpaqueToken();
  const verifier = generateOpaqueToken();
  const loginParams = new URL(request.url).searchParams;
  const destination = loginDestination(loginParams.get('interval'), loginParams.get('trial'));
  const context = await signContext(env, 'google-login', { state, nonce, verifier, destination });
  // Reuse the registered callback URI; login and Calendar have separate state and handlers.
  const redirectUri = `${env.API_ORIGIN || 'https://api.stuflo.com'}/v1/connections/google/callback`;
  const query = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri,
    response_type: 'code', scope: 'openid email profile', state, nonce,
    code_challenge: await hashOpaqueToken(verifier), code_challenge_method: 'S256',
    prompt: 'select_account', include_granted_scopes: 'false' });
  return new Response(null, { status: 303, headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
    'set-cookie': contextCookie(OAUTH_COOKIE, context, request.url), 'cache-control': 'no-store' } });
}

export function googleIdentity(payload: JWTPayload, nonce: string) {
  const email = normalizeEmail(payload.email);
  if (!payload.sub || !email || payload.email_verified !== true || payload.nonce !== nonce) {
    throw new Error('Invalid Google identity.');
  }
  return { subject: payload.sub, email,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    emailAuthoritative: email.endsWith('@gmail.com') || (typeof payload.hd === 'string' && Boolean(payload.hd)) };
}

export async function finishGoogleSignIn(env: StufloEnv, request: Request) {
  const url = new URL(request.url);
  const appOrigin = env.APP_ORIGIN || 'https://app.stuflo.com';
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  headers.append('set-cookie', contextCookie(OAUTH_COOKIE, '', request.url, true));
  const context = await readContext(env, request, OAUTH_COOKIE, 'google-login');
  const destination = typeof context?.destination === 'string' &&
    ['/dashboard', '/auth/checkout?interval=monthly', '/auth/checkout?interval=yearly',
      '/auth/checkout?interval=monthly&trial=1', '/auth/checkout?interval=yearly&trial=1'].includes(context.destination)
    ? context.destination : '/dashboard';
  const checkoutParams = new URL(destination, appOrigin).searchParams;
  const interval = checkoutParams.get('interval');
  const failedUrl = new URL('/auth/signin', appOrigin);
  if (interval) failedUrl.searchParams.set('interval', interval);
  if (checkoutParams.get('trial') === '1') failedUrl.searchParams.set('trial', '1');
  try {
    if (!context || context.state !== url.searchParams.get('state') || typeof context.nonce !== 'string' ||
      typeof context.verifier !== 'string') throw new Error('Invalid login state.');
    if (url.searchParams.has('error')) throw new Error('Google sign-in cancelled.');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw new Error('Missing Google code.');
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${env.API_ORIGIN || 'https://api.stuflo.com'}/v1/connections/google/callback`,
        code, code_verifier: context.verifier, grant_type: 'authorization_code' }) });
    const tokens = await response.json() as { id_token?: string };
    if (!response.ok || !tokens.id_token) throw new Error('Google sign-in failed.');
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, { algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID });
    if (payload.azp && payload.azp !== env.GOOGLE_CLIENT_ID) throw new Error('Invalid Google audience.');
    const identity = googleIdentity(payload, context.nonce);
    const sessionToken = generateOpaqueToken();
    const opened = openDatabase(env);
    let result;
    try {
      result = await signInGoogleIdentity(opened.db, { ...identity,
        sessionTokenHash: await hashOpaqueToken(sessionToken),
        sessionExpiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1_000) });
    } finally { await opened.close(); }
    if (result.needsEmail) {
      const link = await signContext(env, 'google-link', { sub: identity.subject, email: identity.email });
      headers.append('set-cookie', contextCookie(LINK_COOKIE, link, request.url));
      failedUrl.searchParams.set('google', 'verify_email');
      headers.set('location', failedUrl.toString());
    } else {
      if (!result.session) throw new Error('Account unavailable.');
      await getUsageStatus(env, result.session.studentKey);
      headers.append('set-cookie', serializeSessionCookie(sessionToken, request.url));
      headers.append('set-cookie', contextCookie(LINK_COOKIE, '', request.url, true));
      headers.set('location', new URL(destination, appOrigin).toString());
    }
  } catch {
    // Never log authorization codes, tokens, identity payloads, or callback URLs.
    failedUrl.searchParams.set('google', url.searchParams.has('error') ? 'cancelled' : 'error');
    headers.set('location', failedUrl.toString());
  }
  return new Response(null, { status: 303, headers });
}
