import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StufloEnv } from '../src/env';

const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), lock: vi.fn(), close: vi.fn(), deleteObject: vi.fn() }));
vi.mock('@stuflo/db', () => ({ createAttachment: vi.fn(), getAttachmentsForStudent: mocks.get,
  deleteAttachmentForStudent: mocks.remove, withStudentStorageLock: mocks.lock }));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
vi.mock('../src/http', () => ({ json: (body: unknown, status = 200) => Response.json(body, { status }) }));
import { deleteAttachment } from '../src/services/attachments';

const id = '11111111-1111-4111-8111-111111111111';
const student = { studentId: 'owner', studentKey: 'key' };
const env = { ATTACHMENTS: { delete: mocks.deleteObject } } as unknown as StufloEnv;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lock.mockImplementation(async (_db, _owner, operation) => operation({ transaction: true }));
  mocks.get.mockResolvedValue([{ id, source: 'canvas', r2Key: 'private-key' }]);
  mocks.remove.mockResolvedValue({ id, r2Key: 'private-key' });
});

describe('attachment deletion', () => {
  it('does not delete another student’s file or a malformed ID', async () => {
    expect((await deleteAttachment(env, student, 'bad-id')).status).toBe(404);
    mocks.get.mockResolvedValue([]);
    expect((await deleteAttachment(env, student, id)).status).toBe(404);
    expect(mocks.get).toHaveBeenCalledWith({ transaction: true }, 'owner', [id]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it('keeps a Canvas source tombstone and serializes with simultaneous saves', async () => {
    mocks.get.mockResolvedValueOnce([{ id, source: 'canvas', r2Key: 'private-key' }]).mockResolvedValue([]);
    expect((await deleteAttachment(env, student, id)).status).toBe(204);
    expect(mocks.lock).toHaveBeenCalledWith({}, 'owner', expect.any(Function));
    expect(mocks.remove).toHaveBeenCalledWith({ transaction: true }, 'owner', id, true);
    expect(mocks.deleteObject).toHaveBeenCalledWith('private-key');
  });

  it('physically removes ordinary uploaded attachment metadata', async () => {
    mocks.get.mockResolvedValueOnce([{ id, source: 'upload', r2Key: 'private-key' }]).mockResolvedValue([]);
    expect((await deleteAttachment(env, student, id)).status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith({ transaction: true }, 'owner', id, false);
  });

  it('does not remove the object when metadata deletion fails', async () => {
    mocks.remove.mockRejectedValue(new Error('Database unavailable'));
    await expect(deleteAttachment(env, student, id)).rejects.toThrow('Database unavailable');
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('keeps active bytes untouched when metadata commit fails after the delete statement', async () => {
    mocks.lock.mockImplementationOnce(async (_db, _owner, operation) => {
      await operation({ transaction: true });
      throw new Error('Commit connection lost');
    });
    await expect(deleteAttachment(env, student, id)).rejects.toThrow('Commit connection lost');
    expect(mocks.remove).toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it('never removes a copy restored between the metadata commit and cleanup', async () => {
    expect((await deleteAttachment(env, student, id)).status).toBe(204);
    expect(mocks.lock).toHaveBeenCalledTimes(2);
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it('retries idempotent R2 cleanup after committing metadata', async () => {
    mocks.get.mockResolvedValueOnce([{ id, source: 'canvas', r2Key: 'private-key' }]).mockResolvedValue([]);
    mocks.deleteObject.mockRejectedValueOnce(new Error('R2 temporarily unavailable'));
    expect((await deleteAttachment(env, student, id)).status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.deleteObject).toHaveBeenCalledTimes(2);
    expect(mocks.lock).toHaveBeenCalledTimes(3);
  });

  it('retains committed deletion when cleanup stays unavailable', async () => {
    mocks.get.mockResolvedValueOnce([{ id, source: 'canvas', r2Key: 'private-key' }]).mockResolvedValue([]);
    mocks.deleteObject.mockRejectedValue(new Error('R2 temporarily unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await deleteAttachment(env, student, id)).status).toBe(204);
      expect(mocks.deleteObject).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
});
