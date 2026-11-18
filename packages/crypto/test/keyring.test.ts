import { describe, expect, it } from 'vitest';
import { ENCRYPTION_VERSION, WebCryptoKeyring, generateEncodedAesKey } from '../src';

describe('WebCryptoKeyring', () => {
  it('round-trips JSON in a versioned AES-GCM envelope', async () => {
    const keyring = new WebCryptoKeyring({ 'cookie-key-1': generateEncodedAesKey() });
    const envelope = await keyring.encryptJson({ cookies: [{ name: 'session', value: 'secret' }] }, 'cookie-key-1');
    expect(envelope).toMatchObject({ v: ENCRYPTION_VERSION, kid: 'cookie-key-1' });
    expect(envelope.iv).not.toContain('=');
    await expect(keyring.decryptJson(envelope)).resolves.toEqual({
      cookies: [{ name: 'session', value: 'secret' }],
    });
  });

  it('binds ciphertext to the declared key id', async () => {
    const key = generateEncodedAesKey();
    const keyring = new WebCryptoKeyring({ one: key, two: key });
    const envelope = await keyring.encryptJson({ ok: true }, 'one');
    await expect(keyring.decryptJson({ ...envelope, kid: 'two' })).rejects.toThrow(/could not be decrypted/);
  });

  it('rejects missing and incorrectly sized keys', async () => {
    const keyring = new WebCryptoKeyring({ short: 'AQID' });
    await expect(keyring.encryptJson({}, 'short')).rejects.toThrow(/32 bytes/);
    await expect(keyring.encryptJson({}, 'missing')).rejects.toThrow(/not configured/);
  });
});
