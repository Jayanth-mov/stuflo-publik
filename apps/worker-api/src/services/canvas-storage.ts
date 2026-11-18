import {
  deleteAttachmentForStudent,
  getAttachmentsForStudent,
  getCanvasAttachmentBySourceKey,
  getCanvasAttachmentForFile,
  getCanvasStorageUsage,
  listCanvasAttachments,
  upsertCanvasAttachment,
  withStudentStorageLock,
} from '@stuflo/db';
import type { StufloEnv } from '../env';
import { json } from '../http';
import { openDatabase } from './database';
import { cleanupDeletedAttachmentObject } from './attachment-cleanup';

export const CANVAS_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024;
export const MAX_CANVAS_FILE_BYTES = 15 * 1024 * 1024;

export type CanvasStoragePurpose = 'syllabus' | 'assignment' | 'course_resource';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_INVALID_INITIALIZER_HASHES = new Set([
  '098695fee9fae815da705c36af44d11243823c346629108c1adfd91be101b51e',
  '447bb0e4248037c23e3db0fa89bf103ba8c4ecec8b75ef2248bad4d30b339f77',
  '2c33b96d1cfc5334861e26a835210bb70f85f75759e4eca5fd05d40fcefa2436',
]);

export function isKnownInvalidCanvasInitializerArtifact(file: {
  id: string;
  sourceKey: string | null;
  sha256: string;
}, protectedAttachmentIds: Set<string>) {
  return !protectedAttachmentIds.has(file.id) &&
    (file.sourceKey || '').includes('|initializer:') &&
    KNOWN_INVALID_INITIALIZER_HASHES.has(file.sha256);
}

export interface StoreCanvasResourceInput {
  bytes: ArrayBuffer;
  fileName: string;
  mimeType: string;
  sourceKey: string;
  sourceUrl: string;
  canvasHost: string;
  courseId: string;
  courseName: string;
  purpose: CanvasStoragePurpose;
  restoreDeleted?: boolean;
}

function canvasFileId(input: StoreCanvasResourceInput): string | null {
  try {
    const url = new URL(input.sourceUrl);
    if (url.hostname.toLowerCase() !== input.canvasHost.toLowerCase()) return null;
    return url.pathname.match(/\/files\/(\d+)(?:\/|$)/)?.[1] || null;
  } catch { return null; }
}

function requireBucket(env: StufloEnv): R2Bucket {
  if (!env.ATTACHMENTS) throw new Error('R2 Canvas storage is not configured.');
  return env.ATTACHMENTS;
}

function cleanFileName(value: string): string {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .trim()
    .slice(0, 255);
  return name || 'canvas-resource';
}

function cleanMimeType(value: string): string {
  const mimeType = value.split(';', 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType.slice(0, 200)
    : 'application/octet-stream';
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function storeCanvasResource(
  env: StufloEnv,
  studentId: string,
  input: StoreCanvasResourceInput,
) {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_CANVAS_FILE_BYTES) {
    throw new Error(`Canvas files must be between 1 and ${MAX_CANVAS_FILE_BYTES} bytes.`);
  }
  if (!input.sourceKey || input.sourceKey.length > 1_000) throw new Error('Canvas storage source key is invalid.');
  const bucket = requireBucket(env);
  const opened = openDatabase(env);
  let uploadedKey: string | undefined;
  let originalKey: string | undefined;
  const fileId = canvasFileId(input);
  let sourceKey = fileId ? `${input.canvasHost.toLowerCase()}|course:${input.courseId}|file:${fileId}` : input.sourceKey;
  try {
    const sha256 = toHex(await crypto.subtle.digest('SHA-256', input.bytes));
    let saved;
    try {
      saved = await withStudentStorageLock(opened.db, studentId, async (transaction) => {
    const [exact, usage] = await Promise.all([
      getCanvasAttachmentBySourceKey(transaction, studentId, sourceKey),
      getCanvasStorageUsage(transaction, studentId),
    ]);
    const fileAlias = fileId ? await getCanvasAttachmentForFile(transaction, studentId, input.canvasHost, input.courseId, fileId) : null;
    // Legacy initializer and chat keys can name the same Canvas file. A user's
    // deletion wins over a surviving alias during automatic synchronization.
    if (fileAlias?.status === 'deleted' && !input.restoreDeleted) {
      throw new Error('This Canvas resource was deleted by the student. An explicit manual course refresh can restore it.');
    }
    const existing = exact || fileAlias ||
      (sourceKey !== input.sourceKey ? await getCanvasAttachmentBySourceKey(transaction, studentId, input.sourceKey) : null);
    sourceKey = existing?.sourceKey || sourceKey;
    if (existing?.status === 'deleted' && !input.restoreDeleted) {
      throw new Error('This Canvas resource was deleted by the student. An explicit manual course refresh can restore it.');
    }
    originalKey = existing?.r2Key;
    const projectedBytes = usage.bytesUsed - (existing && existing.status !== 'deleted' ? existing.sizeBytes : 0) + input.bytes.byteLength;
    if (projectedBytes > CANVAS_STORAGE_QUOTA_BYTES) {
      throw new Error('Canvas storage quota reached. Delete saved files from Memory & Storage and try again.');
    }

    const id = existing?.id || crypto.randomUUID();
    const r2Key = existing?.sha256 === sha256
      ? existing.r2Key
      : `students/${studentId}/canvas/${id}/${sha256.slice(0, 20)}-${crypto.randomUUID()}`;
    const objectExists = existing?.sha256 === sha256 && await bucket.head(r2Key);
    if (!objectExists) {
      await bucket.put(r2Key, input.bytes, {
        httpMetadata: { contentType: cleanMimeType(input.mimeType) },
        customMetadata: {
          attachmentId: id,
          studentId,
          source: 'canvas',
          purpose: input.purpose,
          courseId: input.courseId.slice(0, 200),
          sha256,
        },
      });
      uploadedKey = r2Key;
    }

      const stored = await upsertCanvasAttachment(transaction, {
        id,
        studentId,
        r2Key,
        fileName: cleanFileName(input.fileName),
        mimeType: cleanMimeType(input.mimeType),
        sizeBytes: input.bytes.byteLength,
        sha256,
        purpose: input.purpose,
        sourceKey,
        sourceUrl: input.sourceUrl.slice(0, 2_000),
        canvasHost: input.canvasHost.slice(0, 255),
        courseId: input.courseId.slice(0, 200),
        courseName: input.courseName.slice(0, 500),
      });
      return {
        cleanupKey: existing && existing.r2Key !== r2Key ? existing.r2Key : null,
        result: {
        ...stored,
        url: `/v1/attachments/${stored.id}`,
        bytesUsed: projectedBytes,
        quotaBytes: CANVAS_STORAGE_QUOTA_BYTES,
        },
      };
      });
    } catch (error) {
      if (uploadedKey && uploadedKey !== originalKey) {
        try {
          await withStudentStorageLock(opened.db, studentId, async (transaction) => {
            const current = await getCanvasAttachmentBySourceKey(transaction, studentId, sourceKey);
            // A commit failure can have an unknown outcome. Never remove an active object.
            if (current?.r2Key !== uploadedKey) await bucket.delete(uploadedKey!);
          });
        } catch {
          console.error('An unreferenced Canvas upload could not be cleaned up.');
        }
      }
      throw error;
    }
    if (saved.cleanupKey) {
      // Cleanup follows the metadata commit. Its failure cannot undo the active file.
      await bucket.delete(saved.cleanupKey).catch(() => console.error('An old Canvas resource version could not be cleaned up.'));
    }
    return saved.result;
  } finally {
    await opened.close();
  }
}

export async function storeCanvasTextSnapshot(
  env: StufloEnv,
  studentId: string,
  input: Omit<StoreCanvasResourceInput, 'bytes' | 'mimeType'> & { text: string },
) {
  return storeCanvasResource(env, studentId, {
    ...input,
    bytes: new TextEncoder().encode(input.text).buffer as ArrayBuffer,
    mimeType: 'text/plain',
  });
}

export async function listCanvasStorage(env: StufloEnv, studentId: string) {
  const opened = openDatabase(env);
  try {
    const [files, usage] = await Promise.all([
      listCanvasAttachments(opened.db, studentId),
      getCanvasStorageUsage(opened.db, studentId),
    ]);
    return {
      files: files.map((file) => ({
        ...file,
        url: `/v1/attachments/${file.id}`,
      })),
      bytesUsed: usage.bytesUsed,
      fileCount: usage.fileCount,
      quotaBytes: CANVAS_STORAGE_QUOTA_BYTES,
    };
  } finally {
    await opened.close();
  }
}

export async function cleanupKnownInvalidCanvasInitializerArtifacts(
  env: StufloEnv,
  studentId: string,
  protectedAttachmentIds: Set<string>,
) {
  const bucket = requireBucket(env);
  const opened = openDatabase(env);
  let removed = 0;
  try {
    const summaries = await listCanvasAttachments(opened.db, studentId);
    const files = await getAttachmentsForStudent(
      opened.db,
      studentId,
      summaries.map((file) => file.id),
    );
    for (const file of files) {
      if (!isKnownInvalidCanvasInitializerArtifact(file, protectedAttachmentIds)) continue;
      const deleted = await withStudentStorageLock(opened.db, studentId, async (transaction) => {
        const [current] = await getAttachmentsForStudent(transaction, studentId, [file.id]);
        if (!current || !isKnownInvalidCanvasInitializerArtifact(current, protectedAttachmentIds)) return null;
        const removedFile = await deleteAttachmentForStudent(transaction, studentId, current.id);
        return removedFile;
      });
      if (deleted) {
        removed += 1;
        await cleanupDeletedAttachmentObject(opened.db, bucket, studentId, deleted.id, deleted.r2Key);
      }
    }
    return removed;
  } finally {
    await opened.close();
  }
}

export async function readCanvasStoredResource(
  env: StufloEnv,
  studentId: string,
  attachmentId: string,
) {
  if (!UUID_PATTERN.test(attachmentId)) throw new Error('Saved Canvas resource ID is invalid.');
  const bucket = requireBucket(env);
  const opened = openDatabase(env);
  try {
    const [attachment] = await getAttachmentsForStudent(opened.db, studentId, [attachmentId]);
    if (!attachment || attachment.source !== 'canvas') {
      throw new Error('Saved Canvas resource was not found.');
    }
    if (!attachment.r2Key.startsWith(`students/${studentId}/canvas/`)) throw new Error('Saved Canvas resource storage location is invalid.');
    if (attachment.sizeBytes > MAX_CANVAS_FILE_BYTES) throw new Error('Saved Canvas resource is too large to inspect.');
    const object = await bucket.get(attachment.r2Key);
    if (!object) throw new Error('Saved Canvas resource is missing from storage.');
    if (object.size > MAX_CANVAS_FILE_BYTES) throw new Error('Saved Canvas resource is too large to inspect.');
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > MAX_CANVAS_FILE_BYTES || bytes.byteLength !== attachment.sizeBytes ||
      toHex(await crypto.subtle.digest('SHA-256', bytes)) !== attachment.sha256) throw new Error('Saved Canvas resource failed its integrity check.');
    return {
      file: {
        id: attachment.id,
        name: attachment.fileName,
        contentType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        purpose: attachment.purpose,
        sourceUrl: attachment.sourceUrl,
        canvasHost: attachment.canvasHost,
        courseId: attachment.courseId,
        courseName: attachment.courseName,
        updatedAt: attachment.updatedAt,
      },
      bytes,
    };
  } finally {
    await opened.close();
  }
}

export async function canvasStorageResponse(env: StufloEnv, studentId: string) {
  return json(await listCanvasStorage(env, studentId));
}
