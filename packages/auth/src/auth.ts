export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_COOKIE_NAME = '__Secure-stuflo.session';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailDeliveryError extends Error {
  constructor(
    readonly providerCode: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function generateOpaqueToken(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 24 || byteLength > 64) {
    throw new Error('Token byte length must be between 24 and 64.');
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashOpaqueToken(token: string): Promise<string> {
  if (!token || token.length > 512) throw new Error('Token is missing or too long.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64Url(new Uint8Array(digest));
}

export function readCookie(request: Request, name = SESSION_COOKIE_NAME): string | null {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

function cookieDomain(url: URL): string | null {
  return url.hostname === 'stuflo.com' || url.hostname.endsWith('.stuflo.com')
    ? '.stuflo.com'
    : null;
}

export function serializeSessionCookie(
  token: string,
  requestUrl: string,
  maxAgeSeconds = SESSION_TTL_SECONDS,
): string {
  const url = new URL(requestUrl);
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ];
  const domain = cookieDomain(url);
  if (domain) attributes.push(`Domain=${domain}`);
  return attributes.join('; ');
}

export function serializeExpiredSessionCookie(requestUrl: string): string {
  return `${serializeSessionCookie('', requestUrl, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
