import { workerApiFetch } from '@/lib/worker-api';
import { NextResponse } from 'next/server';

const MAX_CONNECTOR_COOKIES = 100;
const MAX_CONNECTOR_PAYLOAD_BYTES = 120_000;

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_CONNECTOR_PAYLOAD_BYTES) {
    return NextResponse.json({ error: 'Canvas cookie payload is too large' }, { status: 413 });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CONNECTOR_PAYLOAD_BYTES) {
    return NextResponse.json({ error: 'Canvas cookie payload is too large' }, { status: 413 });
  }
  let body;
  try { body = JSON.parse(text); } catch {
    return NextResponse.json({ error: 'Invalid Canvas connector JSON' }, { status: 400 });
  }
  const { canvasUrl, cookies } = body || {};
  if (typeof canvasUrl !== 'string' || !Array.isArray(cookies)) {
    return NextResponse.json({ error: 'canvasUrl and cookies[] required' }, { status: 400 });
  }
  if (cookies.length === 0) {
    return NextResponse.json({ error: 'No Canvas cookies received' }, { status: 400 });
  }
  if (cookies.length > MAX_CONNECTOR_COOKIES) {
    return NextResponse.json({ error: 'Too many Canvas cookies received' }, { status: 413 });
  }
  const response = await workerApiFetch('/v1/connections/canvas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canvasConnection: { canvasHost: canvasUrl, cookies } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && data && typeof data === 'object') {
    const code = typeof data.error === 'string' ? data.error : 'canvas_connection_failed';
    const message = typeof data.message === 'string' ? data.message : code;
    return NextResponse.json({ ...data, code, error: message }, { status: response.status });
  }
  return NextResponse.json(data, { status: response.status });
}
