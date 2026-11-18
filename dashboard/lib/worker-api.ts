import { cookies } from 'next/headers';

export const STUFLO_API_ORIGIN = (
  process.env.STUFLO_API_URL || 'https://api.stuflo.com'
).replace(/\/$/, '');

export async function workerApiFetch(path: string, init: RequestInit = {}) {
  const cookieStore = await cookies();
  const headers = new Headers(init.headers);
  const cookie = cookieStore.toString();
  if (cookie) headers.set('cookie', cookie);
  return fetch(`${STUFLO_API_ORIGIN}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
}

export async function workerApiJson<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const response = await workerApiFetch(path, init);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export async function proxyWorkerRequest(request: Request, workerPath: string) {
  const requestUrl = new URL(request.url);
  const target = new URL(workerPath, STUFLO_API_ORIGIN);
  target.search = requestUrl.search;
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'cookie', 'dnt', 'origin', 'sec-gpc', 'stripe-signature', 'x-stuflo-file-name']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  const responseHeaders = new Headers();
  for (const name of [
    'cache-control',
    'content-disposition',
    'content-type',
    'location',
    'x-content-type-options',
  ]) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
