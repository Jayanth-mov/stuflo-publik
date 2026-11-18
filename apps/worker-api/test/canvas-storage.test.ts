import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StufloEnv } from '../src/env';

const state = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), baselineBytes: 0,
  locks: new Map<string, Promise<void>>(), objects: new Map<string, ArrayBuffer>() }));
const mocks = vi.hoisted(() => ({ existing: vi.fn(), fileAlias: vi.fn(), usage: vi.fn(), upsert: vi.fn(), getFiles: vi.fn(), lock: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', () => ({
  getCanvasAttachmentBySourceKey: mocks.existing, getCanvasAttachmentForFile: mocks.fileAlias, getCanvasStorageUsage: mocks.usage, upsertCanvasAttachment: mocks.upsert,
  getAttachmentsForStudent: mocks.getFiles, withStudentStorageLock: mocks.lock,
  deleteAttachmentForStudent: vi.fn(), listCanvasAttachments: vi.fn(),
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
import { CANVAS_STORAGE_QUOTA_BYTES, MAX_CANVAS_FILE_BYTES, readCanvasStoredResource, storeCanvasResource, storeCanvasTextSnapshot } from '../src/services/canvas-storage';

const student = 'student-id';
const id = '11111111-1111-4111-8111-111111111111';
const bytes = new TextEncoder().encode('syllabus with verified course policies').buffer;
const input = {
  bytes, fileName: 'Syllabus.txt', mimeType: 'text/plain', sourceKey: 'school.instructure.com|course:1|file:2',
  sourceUrl: 'https://school.instructure.com/courses/1/files/2', canvasHost: 'school.instructure.com',
  courseId: '1', courseName: 'History', purpose: 'syllabus' as const,
};
const bucket = {
  put: vi.fn(async (key: string, content: ArrayBuffer) => { state.objects.set(key, content); return null; }),
  head: vi.fn(async (key: string) => state.objects.has(key) ? { size: state.objects.get(key)!.byteLength } : null),
  delete: vi.fn(async (key: string) => { state.objects.delete(key); }),
  get: vi.fn(async (key: string) => {
    const content = state.objects.get(key);
    return content ? { size: content.byteLength, arrayBuffer: async () => content } : null;
  }),
};
const env = { ATTACHMENTS: bucket } as unknown as StufloEnv;
async function digest(content: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', content))].map((value) => value.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear(); state.objects.clear(); state.locks.clear(); state.baselineBytes = 0;
  mocks.existing.mockImplementation(async (_db, owner: string, key: string) => state.rows.get(`${owner}|${key}`) || null);
  mocks.fileAlias.mockResolvedValue(null);
  mocks.usage.mockImplementation(async (_db, owner: string) => ({ bytesUsed: state.baselineBytes + [...state.rows.entries()]
    .filter(([key, row]) => key.startsWith(`${owner}|`) && row.status !== 'deleted').reduce((total, [, row]) => total + Number(row.sizeBytes), 0), fileCount: state.rows.size }));
  mocks.upsert.mockImplementation(async (_db, value: Record<string, unknown>) => {
    const key = `${value.studentId}|${value.sourceKey}`;
    const saved = { ...value, status: 'stored', id: state.rows.get(key)?.id || value.id };
    state.rows.set(key, saved); return saved;
  });
  mocks.lock.mockImplementation(async (db: unknown, owner: string, run: (db: unknown) => Promise<unknown>) => {
    const prior = state.locks.get(owner) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    state.locks.set(owner, prior.then(() => current));
    await prior;
    try { return await run(db); } finally { release(); }
  });
  mocks.getFiles.mockResolvedValue([]);
});

describe('private Canvas storage lifecycle', () => {
  it('does not delete the active new version when old-object cleanup fails after metadata commit', async () => {
    const oldKey = `students/${student}/canvas/${id}/old-version`;
    state.rows.set(`${student}|${input.sourceKey}`, { id, r2Key: oldKey, sizeBytes: 3, sha256: 'old' });
    bucket.delete.mockRejectedValueOnce(new Error('Temporary R2 delete failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const stored = await storeCanvasResource(env, student, input);
      expect(stored.id).toBe(id);
      expect(state.rows.get(`${student}|${input.sourceKey}`)?.r2Key).toBe(stored.r2Key);
      expect(state.objects.has(stored.r2Key)).toBe(true);
      expect(bucket.delete).toHaveBeenCalledTimes(1);
      expect(bucket.delete).toHaveBeenCalledWith(oldKey);
    } finally { log.mockRestore(); }
  });

  it('serializes simultaneous saves so two requests cannot exceed the same remaining quota', async () => {
    state.baselineBytes = CANVAS_STORAGE_QUOTA_BYTES - 12 * 1024 * 1024;
    const content = new Uint8Array(8 * 1024 * 1024).buffer;
    const results = await Promise.allSettled([
      storeCanvasResource(env, student, { ...input, bytes: content, sourceKey: 'one', sourceUrl: 'https://school.instructure.com/courses/1/files/3' }),
      storeCanvasResource(env, student, { ...input, bytes: content, sourceKey: 'two', sourceUrl: 'https://school.instructure.com/courses/1/files/4' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(state.rows.size).toBe(1);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(mocks.lock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates simultaneous reconnect saves and preserves the attachment ID', async () => {
    const [first, second] = await Promise.all([storeCanvasResource(env, student, input), storeCanvasResource(env, student, input)]);
    expect(second.id).toBe(first.id);
    expect(second.r2Key).toBe(first.r2Key);
    expect(state.rows.size).toBe(1);
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  it('deduplicates initializer and chat source keys for the same Canvas file', async () => {
    const first = await storeCanvasResource(env, student, { ...input, sourceKey: 'initializer-key' });
    const second = await storeCanvasResource(env, student, { ...input, sourceKey: 'chat-key', sourceUrl: input.sourceUrl + '/download?download_frd=1' });
    expect(second.id).toBe(first.id);
    expect(second.r2Key).toBe(first.r2Key);
    expect(state.rows.size).toBe(1);
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  it('honors a deletion tombstone during automatic reconnect and chat saves', async () => {
    state.rows.set(`${student}|${input.sourceKey}`, { id, sourceKey: input.sourceKey, status: 'deleted', r2Key: 'old', sizeBytes: bytes.byteLength });
    await expect(storeCanvasResource(env, student, input)).rejects.toThrow('deleted by the student');
    expect(bucket.put).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('honors a deleted legacy alias even when another source alias remains stored', async () => {
    state.rows.set(`${student}|${input.sourceKey}`, { id, status: 'stored', r2Key: 'active', sizeBytes: bytes.byteLength });
    mocks.fileAlias.mockResolvedValue({ id: 'legacy-id', sourceKey: 'legacy-key', status: 'deleted', r2Key: 'old', sizeBytes: bytes.byteLength });
    await expect(storeCanvasResource(env, student, input)).rejects.toThrow('deleted by the student');
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('allows an explicit manual refresh to restore the same ID and charge the full file size', async () => {
    const oldKey = `students/${student}/canvas/${id}/old`;
    state.rows.set(`${student}|${input.sourceKey}`, { id, sourceKey: input.sourceKey, status: 'deleted', r2Key: oldKey, sizeBytes: bytes.byteLength, sha256: await digest(bytes) });
    const result = await storeCanvasResource(env, student, { ...input, restoreDeleted: true });
    expect(result.id).toBe(id);
    expect(result.bytesUsed).toBe(bytes.byteLength);
    expect(state.rows.get(`${student}|${input.sourceKey}`)?.status).toBe('stored');
    expect(state.objects.has(result.r2Key)).toBe(true);
  });

  it('does not remove an active upload when a transaction commit has an unknown outcome', async () => {
    const originalLock = mocks.lock.getMockImplementation()!;
    mocks.lock.mockImplementationOnce(async (...args) => {
      await originalLock(...args);
      throw new Error('Lost connection while committing');
    });
    await expect(storeCanvasResource(env, student, input)).rejects.toThrow('Lost connection while committing');
    const active = state.rows.get(`${student}|${input.sourceKey}`)!;
    expect(state.objects.has(String(active.r2Key))).toBe(true);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('repairs an unchanged saved resource whose R2 object is missing', async () => {
    const key = `students/${student}/canvas/${id}/same-version`;
    state.rows.set(`${student}|${input.sourceKey}`, { id, r2Key: key, sizeBytes: bytes.byteLength, sha256: await digest(bytes) });
    const result = await storeCanvasResource(env, student, input);
    expect(result.id).toBe(id); expect(result.r2Key).toBe(key);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(state.objects.has(key)).toBe(true);
  });

  it('removes a failed new upload while preserving the prior stored version', async () => {
    const oldKey = `students/${student}/canvas/${id}/previous`;
    state.rows.set(`${student}|${input.sourceKey}`, { id, r2Key: oldKey, sizeBytes: 3, sha256: 'old' });
    state.objects.set(oldKey, new Uint8Array(3).buffer);
    mocks.upsert.mockRejectedValueOnce(new Error('Metadata transaction failed'));
    await expect(storeCanvasResource(env, student, input)).rejects.toThrow('Metadata transaction failed');
    expect(state.objects.has(oldKey)).toBe(true);
    expect(state.rows.get(`${student}|${input.sourceKey}`)?.r2Key).toBe(oldKey);
    expect(bucket.delete).toHaveBeenCalledTimes(1);
    expect(bucket.delete.mock.calls[0][0]).not.toBe(oldKey);
  });

  it('counts replacement size rather than charging both old and new versions', async () => {
    const previous = { id, r2Key: `students/${student}/canvas/${id}/previous`, sizeBytes: 10_000, sha256: 'old' };
    state.rows.set(`${student}|${input.sourceKey}`, previous);
    state.baselineBytes = CANVAS_STORAGE_QUOTA_BYTES - 10_000;
    const result = await storeCanvasResource(env, student, input);
    expect(result.bytesUsed).toBe(CANVAS_STORAGE_QUOTA_BYTES - 10_000 + bytes.byteLength);
  });

  it('rejects oversized multibyte text rather than silently storing a truncated document', async () => {
    await expect(storeCanvasTextSnapshot(env, student, { ...input, text: 'é'.repeat(MAX_CANVAS_FILE_BYTES / 2 + 1) }))
      .rejects.toThrow('Canvas files must be between');
    expect(bucket.put).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('does not look up the bucket for invalid or foreign attachment IDs', async () => {
    await expect(readCanvasStoredResource(env, student, 'not-a-uuid')).rejects.toThrow('ID is invalid');
    expect(mocks.getFiles).not.toHaveBeenCalled();
    await expect(readCanvasStoredResource(env, student, id)).rejects.toThrow('was not found');
    expect(mocks.getFiles).toHaveBeenCalledWith({}, student, [id]);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('rejects a foreign object namespace even if metadata is malformed', async () => {
    mocks.getFiles.mockResolvedValue([{ id, source: 'canvas', sizeBytes: 3, r2Key: `students/other/canvas/${id}`, sha256: 'hash' }]);
    await expect(readCanvasStoredResource(env, student, id)).rejects.toThrow('storage location is invalid');
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('refuses oversized R2 objects before allocating their body', async () => {
    mocks.getFiles.mockResolvedValue([{ id, source: 'canvas', sizeBytes: 3, r2Key: `students/${student}/canvas/${id}`, sha256: 'hash' }]);
    const arrayBuffer = vi.fn();
    bucket.get.mockResolvedValueOnce({ size: MAX_CANVAS_FILE_BYTES + 1, arrayBuffer });
    await expect(readCanvasStoredResource(env, student, id)).rejects.toThrow('too large');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses corrupted bytes rather than presenting them as a verified saved syllabus', async () => {
    const key = `students/${student}/canvas/${id}`;
    state.objects.set(key, bytes);
    mocks.getFiles.mockResolvedValue([{ id, source: 'canvas', sizeBytes: bytes.byteLength, r2Key: key, sha256: 'wrong-hash' }]);
    await expect(readCanvasStoredResource(env, student, id)).rejects.toThrow('integrity check');
  });
});
