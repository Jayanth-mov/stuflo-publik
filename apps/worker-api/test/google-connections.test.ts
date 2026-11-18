import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebCryptoKeyring, generateEncodedAesKey } from '@stuflo/crypto';
import type { StufloDatabase } from '@stuflo/db';
import type { StufloEnv } from '../src/env';

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(), getStudent: vi.fn(), deleteConnection: vi.fn(), expireConnection: vi.fn(),
  updateTokens: vi.fn(), upsert: vi.fn(), close: vi.fn(),
}));
vi.mock('@stuflo/db', () => ({
  getGoogleConnectionByStudentKey: mocks.getConnection, getStudentByKey: mocks.getStudent,
  deleteGoogleConnection: mocks.deleteConnection, markGoogleConnectionExpired: mocks.expireConnection,
  updateGoogleTokens: mocks.updateTokens, upsertGoogleConnection: mocks.upsert,
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));

import {
  checkGoogleConnectionForStudent, connectGoogleForStudent, disconnectGoogleForStudent,
  GOOGLE_CALENDAR_SCOPES, loadGoogleForStudent,
} from '../src/services/google-connections';

const encodedKey = generateEncodedAesKey();
const cryptoKeys = new WebCryptoKeyring({ test: encodedKey });
const env = {
  DATABASE_URL: 'postgres://synthetic', COOKIE_ENCRYPTION_KEYS: JSON.stringify({ test: encodedKey }),
  ACTIVE_COOKIE_ENCRYPTION_KEY_ID: 'test', GOOGLE_CLIENT_ID: 'synthetic-id', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
} as StufloEnv;
const db = {} as StufloDatabase;
const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: '2099-01-01T00:00:00Z' };
const connectedAt = new Date('2026-10-01T12:00:00Z');

async function stored(overrides = {}) {
  return {
    studentId: 'student-id', studentKey: 'student_test', googleEmail: 'student@example.com',
    scopes: [...GOOGLE_CALENDAR_SCOPES], encryptedTokens: await cryptoKeys.encryptJson(tokens, 'test'),
    connectedAt, lastRefreshedAt: null, status: 'connected', ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStudent.mockResolvedValue({ id: 'student-id' });
  mocks.getConnection.mockResolvedValue(null);
});

describe('Google Calendar connection lifecycle', () => {
  it('shows expired saved credentials as reconnectable and removable without querying Google', async () => {
    mocks.getConnection.mockResolvedValue(await stored({ status: 'expired' }));
    const fetcher = vi.fn();
    await expect(checkGoogleConnectionForStudent(db, env, 'student_test', true, fetcher))
      .resolves.toMatchObject({ connected: false, googleEmail: 'student@example.com', verificationStatus: 'invalid', reconnectRequired: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not let a malformed saved refresh token prevent other sources from loading', async () => {
    mocks.getConnection.mockResolvedValue(await stored({ encryptedTokens: await cryptoKeys.encryptJson({ ...tokens, refreshToken: null }, 'test') }));
    await expect(loadGoogleForStudent(env, 'student_test')).resolves.toBeUndefined();
    expect(mocks.expireConnection).toHaveBeenCalledExactlyOnceWith(db, 'student-id', connectedAt);
  });

  it('removes only the student Calendar credentials and is idempotent', async () => {
    await expect(disconnectGoogleForStudent(db, 'student_test')).resolves.toEqual({ connected: false });
    await expect(disconnectGoogleForStudent(db, 'student_test')).resolves.toEqual({ connected: false });
    expect(mocks.deleteConnection).toHaveBeenCalledTimes(2);
    expect(mocks.deleteConnection).toHaveBeenCalledWith(db, 'student-id');
    await expect(loadGoogleForStudent(env, 'student_test')).resolves.toBeUndefined();
  });

  it('returns disconnected for missing students without deleting anyone else', async () => {
    mocks.getStudent.mockResolvedValue(null);
    await expect(disconnectGoogleForStudent(db, 'student_missing')).resolves.toEqual({ connected: false });
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

  it('does not call Google during ordinary status polls', async () => {
    mocks.getConnection.mockResolvedValue(await stored());
    const fetcher = vi.fn();
    await expect(checkGoogleConnectionForStudent(db, env, 'student_test', false, fetcher))
      .resolves.toMatchObject({ connected: true, verificationStatus: 'stored', googleEmail: 'student@example.com' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('verifies an explicitly requested status without exposing credentials', async () => {
    mocks.getConnection.mockResolvedValue(await stored());
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    const status = await checkGoogleConnectionForStudent(db, env, 'student_test', true, fetcher);
    expect(status).toMatchObject({ connected: true, verificationStatus: 'valid' });
    expect(JSON.stringify(status)).not.toContain('synthetic-access');
    expect(JSON.stringify(status)).not.toContain('synthetic-refresh');
  });

  it('keeps the connection saved during a temporary Google outage', async () => {
    mocks.getConnection.mockResolvedValue(await stored());
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(checkGoogleConnectionForStudent(db, env, 'student_test', true, fetcher))
      .resolves.toMatchObject({ connected: true, verificationStatus: 'unavailable' });
    expect(mocks.expireConnection).not.toHaveBeenCalled();
  });

  it('records permanent authorization failure against only the original connection generation', async () => {
    mocks.getConnection.mockResolvedValue(await stored({ encryptedTokens: await cryptoKeys.encryptJson({ ...tokens, expiresAt: null }, 'test') }));
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(checkGoogleConnectionForStudent(db, env, 'student_test', true, fetcher))
      .resolves.toMatchObject({ connected: false, verificationStatus: 'invalid', reconnectRequired: true });
    expect(mocks.expireConnection).toHaveBeenCalledExactlyOnceWith(db, 'student-id', connectedAt);
  });

  it('guards refreshed token writes with the original connection generation', async () => {
    mocks.getConnection.mockResolvedValue(await stored());
    const connection = await loadGoogleForStudent(env, 'student_test');
    await connection?.onTokensUpdated?.({ ...tokens, accessToken: 'updated' });
    expect(mocks.updateTokens).toHaveBeenCalledWith(db, 'student-id', expect.any(Object), expect.any(String), connectedAt);
    const encrypted = mocks.updateTokens.mock.calls[0][2];
    await expect(cryptoKeys.decryptJson(encrypted)).resolves.toMatchObject({ accessToken: 'updated' });
  });

  it('reconnects with encrypted credentials and only the approved scopes', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [{ id: 'student@example.com', primary: true, accessRole: 'owner' }] }));
    const input = { studentKey: 'student_test', googleEmail: 'STUDENT@EXAMPLE.COM', tokens, scopes: [...GOOGLE_CALENDAR_SCOPES] };
    await connectGoogleForStudent(db, env, input, { fetch: fetcher });
    expect(mocks.upsert).toHaveBeenCalledWith(db, expect.objectContaining({ googleEmail: 'student@example.com', scopes: [...GOOGLE_CALENDAR_SCOPES] }));
    const saved = mocks.upsert.mock.calls[0][1];
    expect(JSON.stringify(saved.encryptedTokens)).not.toContain('synthetic-refresh');
    await expect(cryptoKeys.decryptJson(saved.encryptedTokens)).resolves.toEqual(tokens);
    await expect(connectGoogleForStudent(db, env, { ...input, scopes: [...input.scopes, 'https://www.googleapis.com/auth/drive'] }, { fetch: fetcher })).rejects.toThrow('exactly the approved');
  });
});
