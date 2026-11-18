import { CanvasError, normalizeCanvasHost, validateCanvasCookies, type CanvasConnection } from '@stuflo/lms';
import { GlobalUsageBudgetExceededError, UsageCreditsExhaustedError } from '@stuflo/usage';
import { StripeWebhookVerificationError } from '@stuflo/billing';
import { EmailDeliveryError } from '@stuflo/auth';
import { PreferencesInputError } from './services/preferences';

export class RequestInputError extends Error {
  constructor(message: string, readonly code = 'invalid_request', readonly status = 400) { super(message); this.name = 'RequestInputError'; }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof RequestInputError) return json({ error: error.code, message: error.message }, error.status);
  if (error instanceof PreferencesInputError) return json({ error: error.code, message: error.message }, error.status);
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'SyntaxError')) {
    return json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }
  if (error instanceof CanvasError) {
    const reconnectRequired =
      error.code === 'session_expired' ||
      error.code === 'permission_denied' ||
      error.code === 'not_connected';
    return json(
      {
        error: error.code,
        message: error.message,
        ...(reconnectRequired ? { status: 'not_logged_in' } : {}),
        ...(typeof error.status === 'number' ? { canvasStatus: error.status } : {}),
        ...(error.endpoint ? { canvasEndpoint: error.endpoint } : {}),
        ...(error.code === 'canvas_unreachable' && error.causeMessage
          ? { canvasCause: error.causeMessage.slice(0, 240) }
          : {}),
      },
      reconnectRequired ? 401 : error.status === 404 ? 404 : 400,
    );
  }
  if (error instanceof UsageCreditsExhaustedError) {
    return json({ error: error.code, message: error.message }, 402);
  }
  if (error instanceof GlobalUsageBudgetExceededError) {
    return json({ error: error.code, message: error.message, period: error.period }, 503, {
      'retry-after': error.period === 'daily' ? '3600' : '86400',
    });
  }
  if (error instanceof StripeWebhookVerificationError) {
    return json({ error: 'invalid_stripe_signature', message: error.message }, 400);
  }
  if (error instanceof EmailDeliveryError) {
    return json({
      error: 'email_delivery_failed',
      message: 'We could not send the sign-in email. Please try again shortly.',
    }, 503);
  }
  return json({ error: 'internal_error', message: 'Unexpected server error.' }, 500);
}

export async function readJsonBody<T>(request: Request, maxBytes = 256_000): Promise<T> {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new RequestInputError('Request body is too large.', 'request_too_large', 413);
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new RequestInputError('Request body is too large.', 'request_too_large', 413); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RequestInputError('Request body must be a JSON object.');
  return parsed as T;
}

export function validateCanvasConnection(value: unknown): CanvasConnection {
  if (!value || typeof value !== 'object') throw new CanvasError('invalid_connection', 'canvasConnection is required.');
  const candidate = value as Partial<CanvasConnection>;
  if (typeof candidate.canvasHost !== 'string' || !Array.isArray(candidate.cookies)) {
    throw new CanvasError('invalid_connection', 'canvasConnection must include canvasHost and cookies.');
  }
  validateCanvasCookies(candidate.cookies);
  return {
    canvasHost: normalizeCanvasHost(candidate.canvasHost),
    cookies: candidate.cookies,
    timeZone: typeof candidate.timeZone === 'string' ? candidate.timeZone : undefined,
  };
}
