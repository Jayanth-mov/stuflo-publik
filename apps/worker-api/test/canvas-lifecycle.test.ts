import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasError, type CanvasConnection } from '@stuflo/lms';
import type { StufloEnv } from '../src/env';

const mocks = vi.hoisted(() => ({ get: vi.fn(), getActive: vi.fn(), student: vi.fn(), update: vi.fn(), upsert: vi.fn(), decrypt: vi.fn(), encrypt: vi.fn(), validate: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', () => ({
  getCanvasConnectionRecordByStudentKey: mocks.get,
  getCanvasConnectionByStudentKey: mocks.getActive,
  getStudentByKey: mocks.student,
  updateCanvasConnectionStatus: mocks.update,
  upsertCanvasConnection: mocks.upsert,
}));
vi.mock('@stuflo/crypto', () => ({ WebCryptoKeyring: { fromJson: () => ({ decryptJson: mocks.decrypt, encryptJson: mocks.encrypt }) } }));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
vi.mock('@stuflo/lms', async (importOriginal) => ({
  ...await importOriginal<typeof import('@stuflo/lms')>(),
  CanvasAdapter: class { validateSession = mocks.validate; },
}));

import { checkCanvasConnectionForStudent, connectCanvasForStudent, loadCanvasForStudent, markCanvasConnectionForReconnect } from '../src/services/canvas-connections';

const env = { DATABASE_URL: 'test', COOKIE_ENCRYPTION_KEYS: 'test', ACTIVE_COOKIE_ENCRYPTION_KEY_ID: 'test' } as StufloEnv;
const connection: CanvasConnection = { canvasHost: 'school.instructure.com', cookies: [{ name: '_normandy_session', value: 'fixture', domain: 'school.instructure.com' }] };
const now = new Date('2026-10-02T16:00:00Z');
function row(status = 'connected', validated = new Date(now.getTime() - 120_000)) {
  return { studentId: 'student', studentKey: 'key', canvasHost: connection.canvasHost, status, timeZone: 'America/Chicago', encryptedCookies: {}, cookiesUpdatedAt: new Date(now.getTime() - 600_000), lastValidatedAt: validated };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  mocks.get.mockResolvedValue(row());
  mocks.getActive.mockResolvedValue(row());
  mocks.decrypt.mockResolvedValue(connection.cookies);
  mocks.encrypt.mockResolvedValue({ v: 'fixture' });
  mocks.update.mockResolvedValue({ status: 'connected' });
  mocks.upsert.mockResolvedValue({ status: 'connected' });
  mocks.student.mockResolvedValue({ id: 'student', timeZone: 'America/Chicago' });
  mocks.validate.mockResolvedValue({ data: { connected: true, canvasHost: connection.canvasHost, userId: '7' }, warnings: [] });
});
afterEach(() => vi.useRealTimers());

describe('Canvas persisted connection lifecycle', () => {
  it('coalesces rapid healthy status polls without another Canvas request', async () => {
    mocks.get.mockResolvedValue(row('connected', new Date(now.getTime() - 10_000)));
    await expect(checkCanvasConnectionForStudent({} as never, env, 'key')).resolves.toMatchObject({ connected: true, verificationStatus: 'stored' });
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it('gives a suspect session time for extension repair instead of expiring on a rapid status poll', async () => {
    mocks.get.mockResolvedValue(row('suspect', new Date(now.getTime() - 10_000)));
    await expect(checkCanvasConnectionForStudent({} as never, env, 'key')).resolves.toMatchObject({ connected: true, reconnectRequired: false, verificationStatus: 'unavailable' });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('ignores stale validation failure when a concurrent reconnect has saved fresh cookies', async () => {
    const old = row('suspect');
    const fresh = { ...row(), cookiesUpdatedAt: now, lastValidatedAt: now };
    mocks.get.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
    mocks.validate.mockResolvedValue({ data: { connected: false, errorCode: 'session_expired' }, warnings: [] });
    mocks.update.mockResolvedValue(null);
    await expect(checkCanvasConnectionForStudent({} as never, env, 'key')).resolves.toMatchObject({ connected: true, verificationStatus: 'stored', cookiesUpdatedAt: now });
    expect(mocks.update).toHaveBeenCalledWith({}, expect.objectContaining({ status: 'expired', expectedCookiesUpdatedAt: old.cookiesUpdatedAt, expectedLastValidatedAt: old.lastValidatedAt }));
  });

  it('ignores stale validation success after a newer check has changed the row', async () => {
    mocks.get.mockResolvedValueOnce(row()).mockResolvedValueOnce(row('expired', now));
    mocks.update.mockResolvedValue(null);
    await expect(checkCanvasConnectionForStudent({} as never, env, 'key')).resolves.toMatchObject({ connected: false, reconnectRequired: true });
  });

  it('keeps the saved connection during Canvas outages without a status mutation', async () => {
    mocks.validate.mockRejectedValue(new CanvasError('canvas_unreachable', 'Canvas temporarily unavailable.'));
    await expect(checkCanvasConnectionForStudent({} as never, env, 'key')).resolves.toMatchObject({ connected: true, verificationStatus: 'unavailable', reconnectRequired: false });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('recovers an expired connection when Canvas accepts its saved session again', async () => {
    mocks.get.mockResolvedValue(row('expired'));
    await expect(checkCanvasConnectionForStudent({} as never, env, 'key')).resolves.toMatchObject({ connected: true, verificationStatus: 'valid' });
    expect(mocks.update).toHaveBeenCalledWith({}, expect.objectContaining({ status: 'connected' }));
  });

  it('includes a saved cookie version in a loaded connection', async () => {
    await expect(loadCanvasForStudent(env, 'key')).resolves.toMatchObject({ cookiesUpdatedAt: row().cookiesUpdatedAt.toISOString() });
    expect(mocks.close).toHaveBeenCalled();
  });

  it('isolates malformed saved cookie data instead of failing the entire chat over RPC', async () => {
    mocks.decrypt.mockResolvedValue([null]);
    await expect(loadCanvasForStudent(env, 'key')).resolves.toBeUndefined();
    expect(mocks.update).toHaveBeenCalledWith({}, expect.objectContaining({ status: 'expired', expectedCookiesUpdatedAt: row().cookiesUpdatedAt }));
    expect(mocks.close).toHaveBeenCalled();
  });

  it('does not let a failure from an old chat session mark freshly reconnected cookies suspect', async () => {
    await markCanvasConnectionForReconnect(env, 'key', 'session_expired', { ...connection, cookiesUpdatedAt: new Date(now.getTime() - 900_000).toISOString() });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it('does not continually extend the grace period for repeated tool failures', async () => {
    mocks.get.mockResolvedValue(row('suspect'));
    await markCanvasConnectionForReconnect(env, 'key', 'session_expired', { ...connection, cookiesUpdatedAt: row().cookiesUpdatedAt.toISOString() });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('orders connects by request arrival rather than slow validation completion', async () => {
    mocks.validate.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 10_000));
      return { data: { connected: true }, warnings: [] };
    });
    await connectCanvasForStudent({} as never, env, 'key', connection);
    expect(mocks.upsert).toHaveBeenCalledWith({}, expect.objectContaining({ cookiesUpdatedAt: now, lastValidatedAt: new Date(now.getTime() + 10_000) }));
  });

  it('leaves the old saved cookies intact when a reconnect is rejected', async () => {
    mocks.validate.mockResolvedValue({ data: { connected: false, errorCode: 'session_expired' }, warnings: [] });
    await expect(connectCanvasForStudent({} as never, env, 'key', connection)).rejects.toMatchObject({ code: 'session_expired' });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
