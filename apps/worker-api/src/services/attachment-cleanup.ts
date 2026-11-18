import { getAttachmentsForStudent, withStudentStorageLock, type StufloDatabase } from '@stuflo/db';

/** Run only after deletion metadata commits. Never remove a restored active copy. */
export async function cleanupDeletedAttachmentObject(
  db: StufloDatabase,
  bucket: R2Bucket,
  studentId: string,
  attachmentId: string,
  r2Key: string,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withStudentStorageLock(db, studentId, async (transaction) => {
        const [active] = await getAttachmentsForStudent(transaction, studentId, [attachmentId]);
        if (active?.r2Key === r2Key) return false;
        await bucket.delete(r2Key);
        return true;
      });
    } catch {
      // R2 deletion is idempotent. Retry once; a cleanup failure cannot undo
      // the already committed deletion or remove a replacement on a retry.
    }
  }
  console.error('A deleted attachment object could not be cleaned up after two attempts.');
  return false;
}
