export const ENCRYPTION_VERSION = 'aes-gcm-2026-01' as const;

export interface EncryptedEnvelope {
  v: typeof ENCRYPTION_VERSION;
  kid: string;
  iv: string;
  ciphertext: string;
}

export type EncodedKeyring = Record<string, string>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new Error('Encryption key material is not valid base64url.', { cause: error });
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function additionalData(kid: string): Uint8Array {
  return encoder.encode(`${ENCRYPTION_VERSION}:${kid}`);
}

async function importKey(encoded: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(encoded);
  if (bytes.byteLength !== 32) throw new Error('AES-256-GCM keys must contain exactly 32 bytes.');
  return crypto.subtle.importKey('raw', toArrayBuffer(bytes), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export class WebCryptoKeyring {
  private readonly encodedKeys: EncodedKeyring;
  private readonly cache = new Map<string, Promise<CryptoKey>>();

  constructor(encodedKeys: EncodedKeyring) {
    if (Object.keys(encodedKeys).length === 0) throw new Error('At least one encryption key is required.');
    this.encodedKeys = { ...encodedKeys };
  }

  static fromJson(value: string): WebCryptoKeyring {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error('COOKIE_ENCRYPTION_KEYS must be a JSON object.', { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('COOKIE_ENCRYPTION_KEYS must be a JSON object.');
    }
    for (const [kid, key] of Object.entries(parsed)) {
      if (!kid || typeof key !== 'string') throw new Error('Every encryption key must have a string key id and value.');
    }
    return new WebCryptoKeyring(parsed as EncodedKeyring);
  }

  async encryptJson(value: unknown, kid: string): Promise<EncryptedEnvelope> {
    const key = await this.getKey(kid);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(additionalData(kid)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(plaintext),
    );
    return {
      v: ENCRYPTION_VERSION,
      kid,
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    };
  }

  async decryptJson<T>(envelope: EncryptedEnvelope): Promise<T> {
    if (envelope.v !== ENCRYPTION_VERSION) {
      throw new Error(`Unsupported encryption envelope version: ${String(envelope.v)}`);
    }
    const key = await this.getKey(envelope.kid);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(base64UrlToBytes(envelope.iv)),
          additionalData: toArrayBuffer(additionalData(envelope.kid)),
          tagLength: 128,
        },
        key,
        toArrayBuffer(base64UrlToBytes(envelope.ciphertext)),
      );
      return JSON.parse(decoder.decode(plaintext)) as T;
    } catch (error) {
      throw new Error('Encrypted data could not be decrypted.', { cause: error });
    }
  }

  private getKey(kid: string): Promise<CryptoKey> {
    const encoded = this.encodedKeys[kid];
    if (!encoded) throw new Error(`Encryption key id is not configured: ${kid}`);
    let key = this.cache.get(kid);
    if (!key) {
      key = importKey(encoded);
      this.cache.set(kid, key);
    }
    return key;
  }
}

export function generateEncodedAesKey(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
