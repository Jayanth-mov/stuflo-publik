import { EmailDeliveryError } from './auth';

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;

export function generateEmailCode() {
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= 4_294_000_000);
  return String(bytes[0] % 1_000_000).padStart(6, '0');
}

export async function hashEmailCode(secret: string, id: string, email: string, code: string) {
  if (secret.length < 32) throw new Error('Authentication secret is not configured.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(JSON.stringify(['stuflo-email-code-v1', id, email, code])));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sendEmailCode(input: {
  apiKey: string; from: string; to: string; code: string; id: string;
}, fetcher: typeof fetch = fetch): Promise<{ id: string }> {
  if (!/^\d{6}$/.test(input.code)) throw new Error('Invalid sign-in code.');
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json', 'idempotency-key': `email-code/${input.id}` },
    body: JSON.stringify({ from: input.from, to: input.to, subject: `${input.code} is your StuFlo sign-in code`,
      text: `Your StuFlo sign-in code is ${input.code}.\n\nEnter it on the sign-in page. It expires in 10 minutes and can be used once. Do not share this code. If you did not request it, ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;padding:24px;color:#222"><h1 style="font-size:24px">Your StuFlo sign-in code</h1><p>Enter this code on the sign-in page:</p><p style="font-size:36px;letter-spacing:8px;color:#A91D38;font-weight:bold">${input.code}</p><p>This code expires in 10 minutes and can be used once.</p><p>Do not share this code. If you did not request it, you can ignore this email.</p></div>` }),
  });
  const payload = await response.json().catch(() => ({})) as { id?: unknown; name?: unknown };
  if (!response.ok || typeof payload.id !== 'string' || !payload.id) {
    const code = typeof payload.name === 'string' && /^[a-z_]{1,80}$/i.test(payload.name)
      ? payload.name : 'email_delivery_failed';
    throw new EmailDeliveryError(code, response.status, 'The sign-in email could not be delivered.');
  }
  return { id: payload.id };
}
