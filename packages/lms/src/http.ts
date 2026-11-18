import { buildCanvasCookieHeader, normalizeCanvasHost } from './cookies';
import { CanvasError } from './errors';
import type { CanvasConnection, FetchLike } from './types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface CanvasHttpOptions {
  fetch?: FetchLike;
  maxPages?: number;
  timeoutMs?: number;
  sessionRetryDelaysMs?: number[];
}

export interface CanvasHttpResult<T> {
  data: T;
  pageCount: number;
}

export interface CanvasBinaryResult {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string | null;
  finalUrl: string;
}

export function stripCanvasPrefix(text: string): string {
  return text.replace(/^\s*while\s*\(\s*1\s*\)\s*;?\s*/, '');
}

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const [urlPart, ...params] = part.split(';').map((item) => item.trim());
    if (params.some((param) => /^rel\s*=\s*["']?next["']?$/i.test(param))) {
      return urlPart.replace(/^</, '').replace(/>$/, '');
    }
  }
  return null;
}

function isPrivateHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (
    value === '::1' ||
    value === '0.0.0.0' ||
    value === '169.254.169.254' ||
    (value.includes(':') && /^(?:fc|fd|fe[89ab])/i.test(value))
  ) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function dispositionFileName(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^['"]|['"]$/g, ''));
    } catch {
      return encoded;
    }
  }
  return value.match(/filename\s*=\s*["']?([^;"']+)/i)?.[1]?.trim() || null;
}

function errorForStatus(status: number, endpoint: string): CanvasError {
  if (status === 401 || (status >= 300 && status < 400)) {
    return new CanvasError('session_expired', 'The Canvas session has expired.', { status, endpoint });
  }
  if (status === 403) {
    return new CanvasError('permission_denied', 'Canvas denied access to this resource.', { status, endpoint });
  }
  if (status === 404) {
    return new CanvasError('not_found', 'The Canvas resource was not found.', { status, endpoint });
  }
  if (status === 429) {
    return new CanvasError('rate_limited', 'Canvas temporarily rate-limited this request.', { status, endpoint });
  }
  return new CanvasError(
    status >= 500 ? 'canvas_unreachable' : 'invalid_response',
    `Canvas returned HTTP ${status}.`,
    { status, endpoint },
  );
}

export class CanvasHttpClient {
  readonly host: string;
  readonly origin: string;
  private readonly cookies: CanvasConnection['cookies'];
  private readonly fetcher: FetchLike;
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private readonly sessionRetryDelaysMs: number[];

  constructor(connection: CanvasConnection, options: CanvasHttpOptions = {}) {
    this.host = normalizeCanvasHost(connection.canvasHost);
    this.origin = `https://${this.host}`;
    const cookieHeader = buildCanvasCookieHeader(connection.cookies, this.host);
    this.cookies = connection.cookies;
    if (!cookieHeader) {
      throw new CanvasError('not_connected', `No saved cookies match Canvas host ${this.host}.`);
    }
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.maxPages = options.maxPages ?? 10;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sessionRetryDelaysMs = options.sessionRetryDelaysMs ?? [250, 1_000];
  }

  async getJson<T>(path: string, options: { paginate?: boolean } = {}): Promise<CanvasHttpResult<T>> {
    let nextUrl: string | null = this.toApiUrl(path).href;
    let pageCount = 0;
    const items: unknown[] = [];

    while (nextUrl) {
      pageCount += 1;
      if (pageCount > this.maxPages) {
        throw new CanvasError('page_limit', `Canvas pagination exceeded ${this.maxPages} pages.`, {
          endpoint: path,
        });
      }

      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          response = await this.fetcher(nextUrl, {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'accept-language': 'en-US,en;q=0.9',
              cookie: buildCanvasCookieHeader(this.cookies, this.host, new URL(nextUrl).pathname),
              origin: this.origin,
              referer: `${this.origin}/`,
              'user-agent': USER_AGENT,
              'x-requested-with': 'XMLHttpRequest',
            },
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (error) {
          throw new CanvasError('canvas_unreachable', 'Canvas could not be reached.', {
            endpoint: path,
            cause: error,
          });
        } finally {
          clearTimeout(timeout);
        }

        const sessionLikeFailure = response.status === 401 || (response.status >= 300 && response.status < 400);
        const retryDelay = this.sessionRetryDelaysMs[attempt];
        if (!response.ok && sessionLikeFailure && retryDelay !== undefined) {
          if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
        break;
      }

      if (!response.ok) throw errorForStatus(response.status, path);

      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(stripCanvasPrefix(text)) : null;
      } catch (error) {
        throw new CanvasError('invalid_response', 'Canvas returned invalid JSON.', {
          status: response.status,
          endpoint: path,
          cause: error,
        });
      }

      if (!options.paginate) return { data: data as T, pageCount };
      if (!Array.isArray(data)) {
        throw new CanvasError('invalid_response', 'A paginated Canvas endpoint returned a non-array response.', {
          status: response.status,
          endpoint: path,
        });
      }
      items.push(...data);

      const next = parseNextLink(response.headers.get('link'));
      nextUrl = next ? this.toApiUrl(next).href : null;
    }

    return { data: items as T, pageCount };
  }

  async getBinary(
    value: string,
    options: { maxBytes: number; allowExternalInitial?: boolean },
  ): Promise<CanvasBinaryResult> {
    const initial = new URL(value, this.origin);
    if (initial.protocol !== 'https:') {
      throw new CanvasError('invalid_connection', 'Canvas file downloads must use HTTPS.');
    }
    if (initial.origin !== this.origin && !options.allowExternalInitial) {
      throw new CanvasError('invalid_connection', 'Canvas file downloads must start on the configured Canvas host.');
    }
    if (initial.origin !== this.origin && isPrivateHost(initial.hostname)) {
      throw new CanvasError('invalid_connection', 'Private network URLs cannot be downloaded.');
    }
    const canvasCredentialed = initial.origin === this.origin;

    let current = initial;
    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(current, {
          method: 'GET',
          headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            ...(canvasCredentialed && current.origin === this.origin ? { cookie: buildCanvasCookieHeader(this.cookies, this.host, current.pathname) } : {}),
            referer: canvasCredentialed && current.origin === this.origin ? `${this.origin}/` : initial.origin,
            'user-agent': USER_AGENT,
          },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        throw new CanvasError('canvas_unreachable', 'The linked resource could not be reached.', {
          endpoint: current.href,
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectCount === 4) {
          throw new CanvasError('invalid_response', 'The linked resource redirected too many times.', {
            status: response.status,
            endpoint: current.href,
          });
        }
        const next = new URL(location, current);
        if (canvasCredentialed && next.origin === this.origin && /^\/(?:login|signin|sign_in|users\/sign_in)(?:\/|$)/i.test(next.pathname)) {
          throw new CanvasError('session_expired', 'Canvas redirected the file request to sign-in.', { status: response.status, endpoint: current.href });
        }
        if (next.protocol !== 'https:' || isPrivateHost(next.hostname)) {
          throw new CanvasError('invalid_connection', 'The linked resource redirected to an unsafe URL.');
        }
        current = next;
        continue;
      }

      if (!response.ok) throw errorForStatus(response.status, current.href);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > options.maxBytes) {
        throw new CanvasError('invalid_response', `The file is larger than ${options.maxBytes} bytes.`, {
          status: 413,
          endpoint: current.href,
        });
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) {
        throw new CanvasError('invalid_response', 'The linked resource was empty.', { endpoint: current.href });
      }
      if (bytes.byteLength > options.maxBytes) {
        throw new CanvasError('invalid_response', `The file is larger than ${options.maxBytes} bytes.`, {
          status: 413,
          endpoint: current.href,
        });
      }
      return {
        bytes,
        contentType: (response.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0]!,
        fileName: dispositionFileName(response.headers.get('content-disposition')),
        finalUrl: current.href,
      };
    }

    throw new CanvasError('invalid_response', 'The linked resource could not be downloaded.');
  }

  private toApiUrl(value: string): URL {
    const url = new URL(value, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/api/v1/')) {
      throw new CanvasError('invalid_connection', 'Canvas requests must stay on the configured Canvas API host.');
    }
    return url;
  }
}
