import { CanvasError } from './errors';
import type { CanvasCookie } from './types';

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isAllowedCanvasHostname(host: string): boolean {
  // Canvas connections use public DNS names, never local or literal-IP endpoints.
  // URL parsing canonicalizes alternate IPv4 forms and IDNs before this check.
  if (host.length > 253 || host.includes(':') || IPV4_PATTERN.test(host)) return false;
  const labels = host.split('.');
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) return false;
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const reserved = ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'home', 'lan', 'corp', 'home.arpa', 'onion'];
  return !reserved.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function normalizeCanvasHost(value: string): string {
  const candidate = value.trim();
  if (!candidate) {
    throw new CanvasError('invalid_connection', 'A Canvas host is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
  } catch (error) {
    throw new CanvasError('invalid_connection', 'The Canvas host is not a valid URL.', { cause: error });
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !isAllowedCanvasHostname(host)
  ) {
    throw new CanvasError('invalid_connection', 'Canvas must use a public HTTPS host.');
  }

  return host;
}

export function validateCanvasCookies(value: unknown): asserts value is CanvasCookie[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new CanvasError('invalid_connection', 'Canvas cookie count must be between 1 and 100.');
  }
  for (const cookie of value) {
    if (
      !cookie || typeof cookie !== 'object' ||
      typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(cookie.name) ||
      typeof cookie.value !== 'string' || cookie.value.length > 16_384 || /[\x00-\x1f\x7f;]/.test(cookie.value) ||
      typeof cookie.domain !== 'string' || !cookie.domain.trim() || cookie.domain.length > 253 ||
      /[\s/\\;\x00-\x1f\x7f]/.test(cookie.domain) ||
      (cookie.path !== undefined && (typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 2_048)) ||
      (cookie.expires !== undefined && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))) ||
      (cookie.hostOnly !== undefined && typeof cookie.hostOnly !== 'boolean') ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') ||
      (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') ||
      (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite))
    ) {
      throw new CanvasError('invalid_connection', 'Canvas cookies have an invalid shape or header value.');
    }
  }
}

export function cookieMatchesHost(cookie: CanvasCookie, host: string): boolean {
  const domain = String(cookie.domain || '').trim().replace(/^\./, '').toLowerCase();
  if (!domain) return false;
  return domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`));
}

function cookieMatchesPath(cookie: CanvasCookie, requestPath: string): boolean {
  const cookiePath = cookie.path || '/';
  return requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

export function buildCanvasCookieHeader(
  cookies: CanvasCookie[],
  host: string,
  requestPath = '/api/v1/',
  nowSeconds = Date.now() / 1000,
): string {
  validateCanvasCookies(cookies);
  const matching = cookies.filter((cookie) => {
    if (!cookie?.name || typeof cookie.value !== 'string') return false;
    if (!cookieMatchesHost(cookie, host) || !cookieMatchesPath(cookie, requestPath)) return false;
    return cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > nowSeconds;
  });

  matching.sort((left, right) => (right.path || '/').length - (left.path || '/').length);
  return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
