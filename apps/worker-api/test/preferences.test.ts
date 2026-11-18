import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StufloEnv } from '../src/env';

const mocks = vi.hoisted(() => ({ getProfile: vi.fn(), list: vi.fn(), upsert: vi.fn(), create: vi.fn(), archive: vi.fn(), close: vi.fn() }));
vi.mock('@stuflo/db', () => ({
  getStudentProfileByKey: mocks.getProfile, listStudentMemoriesByKey: mocks.list,
  upsertStudentProfileByKey: mocks.upsert, createStudentMemoryByKey: mocks.create,
  archiveStudentMemoryByKey: mocks.archive,
}));
vi.mock('../src/services/database', () => ({ openDatabase: () => ({ db: {}, close: mocks.close }) }));
import { addMemory, getPreferences, PreferencesInputError, removeMemory, searchMemories, updatePreferences } from '../src/services/preferences';

const env = {} as StufloEnv;
const key = 'student-key';
beforeEach(() => { vi.resetAllMocks(); mocks.list.mockResolvedValue({ memories: [] }); });

describe('preferences and long-term memory', () => {
  it('updates one preference without resetting the other saved preferences', async () => {
    mocks.upsert.mockResolvedValue({ preferredName: 'Jay', communicationStyle: 'detailed', learningGoals: ['Keep existing goal'] });
    await updatePreferences(env, key, { preferredName: '  Jay  ' });
    expect(mocks.upsert).toHaveBeenCalledWith({}, key, { preferredName: 'Jay' });
  });

  it('supports explicit clearing without treating omitted fields as cleared', async () => {
    await updatePreferences(env, key, { preferredName: null, learningGoals: [], studyPreferences: {} });
    expect(mocks.upsert).toHaveBeenCalledWith({}, key, { preferredName: null, learningGoals: [], studyPreferences: {} });
  });

  it.each([null, [], {}, { responseVerbosity: 'very-long' }, { preferredName: 42 }, { learningGoals: 'graduate' }, { studyPreferences: [] }])
    ('rejects malformed preference input %j before opening a write', async (body) => {
      await expect(updatePreferences(env, key, body as never)).rejects.toBeInstanceOf(PreferencesInputError);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

  it('bounds goals and whitelists study preference keys', async () => {
    await updatePreferences(env, key, { learningGoals: [' ', '  graduate ', ...Array(12).fill('x'.repeat(250))],
      studyPreferences: { bestStudyTime: ' evenings ', useExamples: true, sessionLengthMinutes: -10, ignoredSecret: 'do not store', invalidNumber: Infinity } });
    const input = mocks.upsert.mock.calls[0][2];
    expect(input.learningGoals).toHaveLength(10);
    expect(input.learningGoals[0]).toBe('graduate');
    expect(input.learningGoals[1]).toHaveLength(200);
    expect(input.studyPreferences).toEqual({ bestStudyTime: 'evenings', useExamples: true, sessionLengthMinutes: 0 });
  });

  it('normalizes repeated whitespace and keeps writes scoped to the signed-in student', async () => {
    await addMemory(env, key, { content: '  My\n   exam is Tuesday.  ', category: 'schedule', pinned: true, studentKey: 'other' }, 'assistant');
    expect(mocks.create).toHaveBeenCalledWith({}, key, { content: 'My exam is Tuesday.', category: 'schedule', pinned: true, source: 'assistant' });
  });

  it.each([null, [], { content: ' ' }, { content: 7 }, { content: 'x'.repeat(1001) }])
    ('rejects invalid memories %j', async (body) => {
      await expect(addMemory(env, key, body as never)).rejects.toBeInstanceOf(PreferencesInputError);
      expect(mocks.create).not.toHaveBeenCalled();
    });

  it('returns an actionable conflict when the active-memory limit is reached', async () => {
    mocks.create.mockRejectedValue(new Error('Student memory limit reached.'));
    await expect(addMemory(env, key, { content: 'New fact' })).rejects.toMatchObject({ code: 'memory_limit_reached', status: 409 });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('searches the current store after remember and forget within the same chat turn', async () => {
    const memories: Array<{ id: string; category: string; content: string }> = [];
    mocks.list.mockImplementation(async () => ({ memories: [...memories] }));
    mocks.create.mockImplementation(async (_db, _key, memory) => { const row = { ...memory, id: 'memory-id' }; memories.push(row); return row; });
    mocks.archive.mockImplementation(async () => { memories.length = 0; return { id: 'memory-id' }; });
    expect((await searchMemories(env, key, 'Tuesday')).memories).toHaveLength(0);
    await addMemory(env, key, { content: 'My exam is Tuesday.' });
    expect((await searchMemories(env, key, 'Tuesday')).memories).toHaveLength(1);
    await removeMemory(env, key, 'memory-id');
    expect((await searchMemories(env, key, 'Tuesday')).memories).toHaveLength(0);
    expect(mocks.archive).toHaveBeenCalledWith({}, key, 'memory-id');
  });

  it('matches Unicode topics, ranks relevant facts first, and reports truncated coverage', async () => {
    mocks.list.mockResolvedValue({ memories: [
      { id: 'one', category: 'course', content: 'Biología' },
      { id: 'two', category: 'course', content: 'Biología examen martes' },
      ...Array.from({ length: 35 }, (_, index) => ({ id: String(index), category: 'course', content: 'Biología' })),
    ] });
    const result = await searchMemories(env, key, 'Biología examen');
    expect(result.memories).toHaveLength(30);
    expect(result.memories[0].id).toBe('two');
    expect(result.omitted).toBe(7);
    expect(result.coverage).toContain('37 current active memories');
    expect(mocks.list).toHaveBeenCalledWith({}, key, 100);
  });

  it('does not return a profile for an unknown student', async () => {
    mocks.getProfile.mockResolvedValue(null);
    expect(await getPreferences(env, key)).toBeNull();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
