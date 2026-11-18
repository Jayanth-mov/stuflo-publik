'use client';

import { useMemo, useState } from 'react';
import { Download, ExternalLink, FileArchive, Loader2, Trash2 } from 'lucide-react';

type StoredFile = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  purpose: string;
  courseId: string | null;
  courseName: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function purposeLabel(value: string) {
  if (value === 'syllabus') return 'Syllabus';
  if (value === 'assignment') return 'Assignment';
  return 'Course resource';
}

export default function StorageClient({
  initialFiles,
  initialBytesUsed,
  quotaBytes,
}: {
  initialFiles: StoredFile[];
  initialBytesUsed: number;
  quotaBytes: number;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const bytesUsed = useMemo(() => files.reduce((total, file) => total + file.sizeBytes, 0), [files]);
  const percent = quotaBytes > 0 ? Math.min(100, (bytesUsed / quotaBytes) * 100) : 0;

  async function deleteFile(file: StoredFile) {
    setDeleting(file.id);
    setMessage('');
    try {
      const response = await fetch(`/api/worker/attachments/${encodeURIComponent(file.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Delete failed.');
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setMessage(`${file.fileName} was deleted.`);
    } catch {
      setMessage(`Could not delete ${file.fileName}.`);
    } finally {
      setDeleting(null);
    }
  }

  async function deleteAllFiles() {
    if (files.length === 0 || !window.confirm(`Delete all ${files.length} saved Canvas files? This cannot be undone.`)) return;
    setDeleting('all');
    setMessage('');
    try {
      const results = await Promise.all(files.map(async (file) => {
        try {
          const response = await fetch(`/api/worker/attachments/${encodeURIComponent(file.id)}`, {
            method: 'DELETE',
          });
          return response.ok ? file.id : null;
        } catch {
          return null;
        }
      }));
      const deletedIds = new Set(results.filter((id): id is string => Boolean(id)));
      setFiles((current) => current.filter((file) => !deletedIds.has(file.id)));
      setMessage(
        deletedIds.size === files.length
          ? 'All saved Canvas files were deleted.'
          : `Deleted ${deletedIds.size} of ${files.length} files. You can retry the rest.`,
      );
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start gap-2">
        <FileArchive className="mt-0.5 h-5 w-5 text-primary-500" strokeWidth={1.85} />
        <div className="min-w-52 flex-1">
          <h2 className="text-xl font-bold text-fg1">Canvas storage</h2>
          <p className="text-sm text-fg3">
            Original syllabi and course files Stu downloaded for you. You control and can delete every file.
          </p>
        </div>
        {files.length > 0 && (
          <button
            type="button"
            onClick={() => void deleteAllFiles()}
            disabled={deleting !== null}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-fg2 hover:bg-surface-tint hover:text-danger-600 disabled:opacity-50"
          >
            {deleting === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete all
          </button>
        )}
      </div>

      <div className="rounded-lg border border-line bg-surface-tint p-4">
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="font-medium text-fg2">{formatBytes(bytesUsed)} used</span>
          <span className="text-fg3">{formatBytes(quotaBytes)} total</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="mt-5 divide-y divide-line">
        {files.length === 0 ? (
          <p className="py-6 text-sm text-fg3">Stu has not saved any Canvas files yet.</p>
        ) : (
          files.map((file) => (
            <article key={file.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-semibold text-fg1">{file.fileName}</p>
                  <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700 dark:bg-primary-950 dark:text-primary-300">
                    {purposeLabel(file.purpose)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-fg3">
                  {file.courseName || 'Canvas'} · {formatBytes(file.sizeBytes)} · Saved{' '}
                  {new Date(file.updatedAt || file.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {file.sourceUrl && (
                  <a
                    href={file.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg p-2 text-fg3 hover:bg-surface-tint hover:text-fg1"
                    aria-label={`Open ${file.fileName} source`}
                    title="Open source"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
                <a
                  href={`/api/worker/attachments/${encodeURIComponent(file.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg p-2 text-fg3 hover:bg-surface-tint hover:text-primary-600"
                  aria-label={`Download ${file.fileName}`}
                  title="Download"
                >
                  <Download className="h-4 w-4" />
                </a>
                <button
                  type="button"
                  onClick={() => void deleteFile(file)}
                  disabled={deleting !== null}
                  className="rounded-lg p-2 text-fg3 hover:bg-surface-tint hover:text-danger-600 disabled:opacity-50"
                  aria-label={`Delete ${file.fileName}`}
                  title="Delete"
                >
                  {deleting === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
      {message && <p className="mt-3 text-sm text-fg2">{message}</p>}
      {initialBytesUsed !== bytesUsed && <span className="sr-only">Storage usage updated.</span>}
    </section>
  );
}
