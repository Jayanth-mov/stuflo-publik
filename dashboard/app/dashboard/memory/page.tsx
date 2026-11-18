export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import MemorySettingsClient from '@/components/dashboard/MemorySettingsClient';
import StorageClient from '@/components/dashboard/StorageClient';
import { workerApiJson } from '@/lib/worker-api';

type Preferences = {
  profile: {
    preferredName: string | null;
    communicationStyle: string;
    responseVerbosity: string;
    learningGoals: string[];
    studyPreferences: Record<string, string | number | boolean | string[]>;
  };
  memories: Array<{
    id: string;
    category: string;
    content: string;
    source: string;
    pinned: boolean;
    updatedAt: string;
  }>;
};

type Storage = {
  files: Array<{
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
  }>;
  bytesUsed: number;
  quotaBytes: number;
};

type CanvasKnowledge = {
  run: {
    status: string;
    completedAt?: string | null;
  } | null;
  courses: Array<{
    courseId: string;
    courseName: string;
    courseCode?: string | null;
    termName?: string | null;
    courseUrl: string;
    isActive: boolean;
    syllabusStatus: string;
    syllabusAttachmentIds: string[];
    externalSystems: Array<{ name: string; url: string; kind: string }>;
    initializedAt: string;
  }>;
};

export default async function MemoryPage() {
  const [preferences, storage, canvasKnowledge] = await Promise.all([
    workerApiJson<Preferences>('/v1/preferences'),
    workerApiJson<Storage>('/v1/storage'),
    workerApiJson<CanvasKnowledge>('/v1/canvas/initialization'),
  ]);
  const activeCourses = canvasKnowledge?.courses.filter((course) => course.isActive) || [];
  const historicalCourseCount = canvasKnowledge?.courses.filter((course) => !course.isActive).length || 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fg1">Memory & Storage</h1>
        <p className="mt-1 text-base text-fg3">See and control the personal context and Canvas resources Stu keeps for you.</p>
      </div>
      <MemorySettingsClient
        initialProfile={preferences?.profile || {
          preferredName: null,
          communicationStyle: 'balanced',
          responseVerbosity: 'balanced',
          learningGoals: [],
          studyPreferences: {},
        }}
        initialMemories={preferences?.memories || []}
      />
      <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <h2 className="text-xl font-bold text-fg1">Generated Canvas course knowledge</h2>
        <p className="mt-1 text-sm text-fg3">
          This is separate from personal memory. Stu’s course initializer builds it from read-only Canvas data so it can recognize class structure, saved syllabi, and external systems. It automatically rescans active courses every seven days and updates stored syllabus copies when their source changes; you can also refresh it from Connections at any time.
        </p>
        {activeCourses.length === 0 ? (
          <p className="mt-4 rounded-lg border border-line bg-paper-sunk p-4 text-sm text-fg3">
            No initialized courses yet. Connect Canvas or run the course initializer from Connections.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {activeCourses.map((course) => (
              <article key={course.courseId} className="rounded-lg border border-line bg-paper-sunk p-4">
                <a href={course.courseUrl} target="_blank" rel="noreferrer" className="font-semibold text-fg1 hover:text-primary-600">
                  {course.courseName}
                </a>
                <p className="mt-1 text-xs text-fg3">
                  {[course.courseCode, course.termName].filter(Boolean).join(' · ') || 'Active Canvas course'}
                </p>
                <p className="mt-3 text-sm text-fg2">
                  {course.syllabusStatus === 'stored'
                    ? `${course.syllabusAttachmentIds.length} saved syllabus ${course.syllabusAttachmentIds.length === 1 ? 'copy' : 'copies'}`
                    : course.syllabusStatus === 'not_found'
                      ? 'No syllabus found'
                      : 'Syllabus needs another scan'}
                </p>
                {course.externalSystems.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {course.externalSystems.slice(0, 8).map((system) => (
                      <a
                        key={`${system.name}-${system.url}`}
                        href={system.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700 dark:bg-primary-950 dark:text-primary-300"
                      >
                        {system.name}
                      </a>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        {historicalCourseCount > 0 && (
          <p className="mt-3 text-xs text-fg3">Stu also keeps a lightweight catalog of {historicalCourseCount} completed Canvas {historicalCourseCount === 1 ? 'course' : 'courses'}.</p>
        )}
      </section>
      <StorageClient
        initialFiles={storage?.files || []}
        initialBytesUsed={storage?.bytesUsed || 0}
        quotaBytes={storage?.quotaBytes || 100 * 1024 * 1024}
      />
    </div>
  );
}
