import { describe, expect, it, vi } from 'vitest';
import { generateEmailCode, hashEmailCode, sendEmailCode, normalizeEmail, generateOpaqueToken,
  hashOpaqueToken, serializeSessionCookie, serializeExpiredSessionCookie, readCookie, SESSION_COOKIE_NAME } from '../src';

describe('passwordless auth primitives', () => {
  it('normalizes email and rejects malformed addresses', () => {
    expect(normalizeEmail(' Student@Example.COM ')).toBe('student@example.com');
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
  it('uses six-digit cryptographic codes and context-bound keyed hashes', async () => {
    expect(generateEmailCode()).toMatch(/^\d{6}$/);
    const key = 'k'.repeat(40);
    const hash = await hashEmailCode(key, 'id', 'student@example.com', '012345');
    expect(hash).toHaveLength(64);
    expect(await hashEmailCode(key, 'id2', 'student@example.com', '012345')).not.toBe(hash);
    expect(await hashEmailCode(key, 'id', 'other@example.com', '012345')).not.toBe(hash);
    expect(await hashEmailCode('j'.repeat(40), 'id', 'student@example.com', '012345')).not.toBe(hash);
    await expect(hashEmailCode('', 'id', 'a@b.com', '123456')).rejects.toThrow();
  });
  it('does not expose raw session tokens in their hashes', async () => {
    const token = generateOpaqueToken();
    expect(token).toHaveLength(43);
    expect(await hashOpaqueToken(token)).not.toBe(token);
  });
  it('preserves secure existing sessions and logout cookies', () => {
    const cookie = serializeSessionCookie('session', 'https://api.stuflo.com');
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(cookie).toContain('Domain=.stuflo.com');
    expect(serializeExpiredSessionCookie('https://api.stuflo.com')).toContain('Max-Age=0');
    expect(readCookie(new Request('https://api.stuflo.com', { headers: { cookie: `${SESSION_COOKIE_NAME}=session` } }))).toBe('session');
  });
  it('sends a code, no sign-in URL, and requires a real delivery id', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'message-id' }));
    const input = { apiKey: 'test', from: 'Stu <stu@stuflo.com>', to: 'student@example.com', code: '012345', id: 'request-id' };
    expect(await sendEmailCode(input, fetcher)).toEqual({ id: 'message-id' });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.text).toContain('012345');
    expect(body.text).not.toContain('https://');
    await expect(sendEmailCode(input, vi.fn().mockResolvedValue(Response.json({})))).rejects.toMatchObject({ name: 'EmailDeliveryError' });
    await expect(sendEmailCode(input, vi.fn().mockResolvedValue(Response.json({ name: 'invalid_api_key', message: 'secret provider text' }, { status: 403 }))))
      .rejects.toMatchObject({ message: 'The sign-in email could not be delivered.', providerCode: 'invalid_api_key' });
  });
});
