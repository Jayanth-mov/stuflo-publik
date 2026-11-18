import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StufloEnv } from '../src/env';

const mocks = vi.hoisted(() => ({ student: vi.fn(), latest: vi.fn(), courses: vi.fn(), files: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', () => ({
  createCanvasInitializationRun: vi.fn(), getLatestCanvasInitializationRun: mocks.latest,
  getStudentByKey: mocks.student, listCanvasCourseSnapshots: mocks.courses,
  listCanvasAttachments: mocks.files, markCanvasCourseSnapshotsInactive: vi.fn(),
  updateCanvasInitializationRun: vi.fn(), upsertCanvasCourseSnapshot: vi.fn(),
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
vi.mock('../src/services/canvas-browser', () => ({ readCanvasPageInBrowser: vi.fn() }));
vi.mock('../src/services/canvas-connections', () => ({ loadCanvasForStudent: vi.fn(), markCanvasConnectionForReconnect: vi.fn() }));
vi.mock('../src/services/canvas-storage', () => ({ cleanupKnownInvalidCanvasInitializerArtifacts: vi.fn(), storeCanvasResource: vi.fn(), storeCanvasTextSnapshot: vi.fn() }));
import { getCanvasInitializationOverview, getCanvasKnowledgeContext, visibleSyllabusReferences } from '../src/services/canvas-initializer';

const env = {} as StufloEnv;
const course = { id: 'snapshot', courseId: '1', courseName: 'History', isActive: true,
  syllabusAttachmentIds: ['deleted-id', 'owned-id'], syllabusStatus: 'stored', snapshot: {}, externalSystems: [] };
beforeEach(() => {
  vi.resetAllMocks(); mocks.student.mockResolvedValue({ id: 'student' });
  mocks.latest.mockResolvedValue(null); mocks.courses.mockResolvedValue([course]);
  mocks.files.mockResolvedValue([{ id: 'owned-id' }]);
});

describe('saved syllabus references after deletion', () => {
  it('removes deleted or foreign references while preserving surviving saved files', () => {
    expect(visibleSyllabusReferences(course, new Set(['owned-id']))).toEqual({ attachmentIds: ['owned-id'], status: 'stored' });
  });

  it('downgrades stored status when all copies are deleted without hiding their original source', () => {
    expect(visibleSyllabusReferences(course, new Set())).toEqual({ attachmentIds: [], status: 'found_not_stored' });
    expect(visibleSyllabusReferences({ syllabusAttachmentIds: [], syllabusStatus: 'not_found' }, new Set()).status).toBe('not_found');
  });

  it('filters dashboard overview through files owned by this student', async () => {
    const overview = await getCanvasInitializationOverview(env, 'key');
    expect(overview?.courses[0].syllabusAttachmentIds).toEqual(['owned-id']);
    expect(mocks.files).toHaveBeenCalledWith({}, 'student');
  });

  it('never tells the chat agent a deleted syllabus is still saved', async () => {
    mocks.files.mockResolvedValue([]);
    const context = await getCanvasKnowledgeContext(env, 'student');
    expect(context[0].syllabus).toMatchObject({ attachmentIds: [], status: 'found_not_stored' });
  });
});
