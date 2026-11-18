import {
  createAttachment,
  deleteAttachmentForStudent,
  getAttachmentsForStudent,
  withStudentStorageLock,
} from '@stuflo/db';
import type { StufloEnv } from '../env';
import { json } from '../http';
import { openDatabase } from './database';
import { cleanupDeletedAttachmentObject } from './attachment-cleanup';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 4;

const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TEXT_CONTEXT_CHARS = 40_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AuthenticatedStudent = {
  studentId: string;
  studentKey: string;
};

function requireBucket(env: StufloEnv): R2Bucket {
  if (!env.ATTACHMENTS) throw new Error('R2 attachments are not configured.');
  return env.ATTACHMENTS;
}

function normalizeFileName(rawValue: string | null): string {
  if (!rawValue) throw new Error('x-stuflo-file-name is required.');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    throw new Error('Attachment filename is invalid.');
  }
  const normalized = decoded
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .trim();
  if (!normalized || normalized.length > 255) {
    throw new Error('Attachment filename must be between 1 and 255 characters.');
  }
  return normalized;
}

function normalizeMimeType(rawValue: string | null): string {
  const value = (rawValue || 'application/octet-stream').split(';', 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
    ? value.slice(0, 200)
    : 'application/octet-stream';
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function safeDisposition(fileName: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function isTextAttachment(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/ld+json' ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml')
  );
}

export async function uploadAttachment(
  request: Request,
  env: StufloEnv,
  student: AuthenticatedStudent,
): Promise<Response> {
  const bucket = requireBucket(env);
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    return json({ error: 'attachment_too_large', maxBytes: MAX_ATTACHMENT_BYTES }, 413);
  }

  let fileName: string;
  try {
    fileName = normalizeFileName(request.headers.get('x-stuflo-file-name'));
  } catch (error) {
    return json({
      error: 'invalid_attachment_name',
      message: error instanceof Error ? error.message : 'Attachment filename is invalid.',
    }, 400);
  }
  const mimeType = normalizeMimeType(request.headers.get('content-type'));
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: 'attachment_empty' }, 400);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return json({ error: 'attachment_too_large', maxBytes: MAX_ATTACHMENT_BYTES }, 413);
  }

  const id = crypto.randomUUID();
  const r2Key = `students/${student.studentId}/attachments/${id}`;
  const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes));
  const expiresAt = new Date(Date.now() + ATTACHMENT_TTL_MS);

  await bucket.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      attachmentId: id,
      studentId: student.studentId,
      fileName: encodeURIComponent(fileName),
      sha256,
    },
  });

  const opened = openDatabase(env);
  try {
    const attachment = await createAttachment(opened.db, {
      id,
      studentId: student.studentId,
      r2Key,
      fileName,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256,
      expiresAt,
    });
    return json({
      id: attachment.id,
      name: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.sizeBytes,
      sha256: attachment.sha256,
      expiresAt: attachment.expiresAt,
      url: `/v1/attachments/${attachment.id}`,
    }, 201);
  } catch (error) {
    await bucket.delete(r2Key);
    throw error;
  } finally {
    await opened.close();
  }
}

export async function downloadAttachment(
  env: StufloEnv,
  student: AuthenticatedStudent,
  attachmentId: string,
): Promise<Response> {
  if (!UUID_PATTERN.test(attachmentId)) return json({ error: 'attachment_not_found' }, 404);
  const bucket = requireBucket(env);
  const opened = openDatabase(env);
  try {
    const [attachment] = await getAttachmentsForStudent(opened.db, student.studentId, [attachmentId]);
    if (!attachment || (attachment.expiresAt && attachment.expiresAt <= new Date())) {
      return json({ error: 'attachment_not_found' }, 404);
    }
    const object = await bucket.get(attachment.r2Key);
    if (!object) return json({ error: 'attachment_not_found' }, 404);
    const headers = new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': safeDisposition(attachment.fileName),
      'content-length': String(attachment.sizeBytes),
      'content-type': attachment.mimeType,
      'x-content-type-options': 'nosniff',
    });
    if (object.httpEtag) headers.set('etag', object.httpEtag);
    return new Response(object.body, { status: 200, headers });
  } finally {
    await opened.close();
  }
}

export async function deleteAttachment(
  env: StufloEnv,
  student: AuthenticatedStudent,
  attachmentId: string,
): Promise<Response> {
  if (!UUID_PATTERN.test(attachmentId)) return json({ error: 'attachment_not_found' }, 404);
  const bucket = requireBucket(env);
  const opened = openDatabase(env);
  try {
    const deleted = await withStudentStorageLock(opened.db, student.studentId, async (transaction) => {
      const [attachment] = await getAttachmentsForStudent(transaction, student.studentId, [attachmentId]);
      if (!attachment) return null;
      const removed = await deleteAttachmentForStudent(transaction, student.studentId, attachmentId, attachment.source === 'canvas');
      if (!removed) return null;
      return removed;
    });
    if (!deleted) return json({ error: 'attachment_not_found' }, 404);
    // The transaction must commit before any destructive object operation.
    await cleanupDeletedAttachmentObject(opened.db, bucket, student.studentId, deleted.id, deleted.r2Key);
    return new Response(null, { status: 204 });
  } finally {
    await opened.close();
  }
}

export async function prepareAttachmentContext(
  env: StufloEnv,
  student: AuthenticatedStudent,
  rawAttachmentIds: unknown,
) {
  if (rawAttachmentIds === undefined) return { attachments: [], context: '' };
  if (!Array.isArray(rawAttachmentIds) || rawAttachmentIds.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new Error(`attachments must contain at most ${MAX_ATTACHMENTS_PER_TURN} IDs.`);
  }
  const ids = rawAttachmentIds.map((value) => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new Error('attachments contains an invalid ID.');
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) throw new Error('attachments contains duplicate IDs.');
  if (ids.length === 0) return { attachments: [], context: '' };

  const bucket = requireBucket(env);
  const opened = openDatabase(env);
  try {
    const rows = await getAttachmentsForStudent(opened.db, student.studentId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id));
    if (ordered.some((row) => !row || (row.expiresAt && row.expiresAt <= new Date()))) {
      throw new Error('One or more attachments are missing, expired, or not owned by this student.');
    }

    let remainingChars = MAX_TEXT_CONTEXT_CHARS;
    const sections: string[] = [];
    for (const attachment of ordered) {
      if (!attachment) continue;
      const description = `${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
      if (!isTextAttachment(attachment.mimeType) || remainingChars <= 0) {
        sections.push(`[Stored attachment: ${description}. Binary content is not available to the text model.]`);
        continue;
      }
      const object = await bucket.get(attachment.r2Key);
      if (!object) throw new Error(`Attachment ${attachment.fileName} is missing from R2.`);
      const text = (await object.text()).replace(/\u0000/g, '');
      const excerpt = text.slice(0, remainingChars);
      remainingChars -= excerpt.length;
      sections.push(
        `[Untrusted attachment text: ${description}]\n${excerpt}\n[End untrusted attachment text]`,
      );
    }

    return {
      attachments: ordered.map((attachment) => ({
        id: attachment!.id,
        name: attachment!.fileName,
        mimeType: attachment!.mimeType,
        size: attachment!.sizeBytes,
        url: `/v1/attachments/${attachment!.id}`,
      })),
      context: sections.join('\n\n'),
    };
  } finally {
    await opened.close();
  }
}
