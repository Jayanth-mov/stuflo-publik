import { describe, expect, it } from 'vitest';
import { CanvasError } from '@stuflo/lms';
import { EmailDeliveryError } from '@stuflo/auth';
import { PreferencesInputError } from '../src/services/preferences';
import { errorResponse, readJsonBody, RequestInputError, validateCanvasConnection } from '../src/http';

describe('Worker API error responses', () => {
  it('maps malformed memory input and memory quota errors to actionable client responses', async () => {
    for (const error of [new PreferencesInputError('Invalid memory', 'invalid_memory'),
      new PreferencesInputError('Forget a memory first', 'memory_limit_reached', 409)]) {
      const response = errorResponse(error);
      expect(response.status).toBe(error.status);
      await expect(response.json()).resolves.toEqual({ error: error.code, message: error.message });
    }
  });
  it('rejects non-object JSON and oversized streamed bodies with client errors', async () => {
    for (const value of ['null', '[]', 'true']) {
      await expect(readJsonBody(new Request('https://api.stuflo.com',{ method: 'POST', body: value }))).rejects.toBeInstanceOf(RequestInputError);
    }
    try {
      await readJsonBody(new Request('https://api.stuflo.com',{ method: 'POST', body: JSON.stringify({value:'🎓'.repeat(20)}) }), 40);
      throw new Error('Body limit was ignored');
    } catch (error) {
      expect(errorResponse(error).status).toBe(413);
    }
    await expect(readJsonBody(new Request('https://api.stuflo.com',{ method:'POST', body: JSON.stringify({message:'🎓'}) }))).resolves.toEqual({message:'🎓'});
  });
  it('rejects malformed Canvas cookies with a client error', async () => {
    for (const cookies of [[null], [{ name: 'session', domain: 'school.instructure.com', value: 7 }]]) {
      try {
        validateCanvasConnection({ canvasHost: 'school.instructure.com', cookies });
        throw new Error('Malformed cookies were accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(CanvasError);
        expect(errorResponse(error).status).toBe(400);
      }
    }
  });

  it('maps malformed JSON from native and cross-realm syntax errors to a client error', async () => {
    const errors = [new SyntaxError('Unexpected token'), Object.assign(new Error('Unexpected token'), { name: 'SyntaxError' })];
    for (const error of errors) {
      const response = errorResponse(error);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_json' });
    }
  });

  it('maps a rejected Canvas browser session to the connector reconnect contract', async () => {
    const response = errorResponse(
      new CanvasError('permission_denied', 'Canvas denied access to this resource.', {
        status: 401,
        endpoint: '/api/v1/users/self/profile',
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'permission_denied',
      status: 'not_logged_in',
      canvasEndpoint: '/api/v1/users/self/profile',
    });
  });

  it('returns a safe retryable error when Resend rejects a sign-in email', async () => {
    const response = errorResponse(
      new EmailDeliveryError('invalid_api_key', 403, 'The sign-in email could not be delivered.'),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'email_delivery_failed',
      message: 'We could not send the sign-in email. Please try again shortly.',
    });
  });
});
