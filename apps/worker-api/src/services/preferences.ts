import {
  archiveStudentMemoryByKey,
  createStudentMemoryByKey,
  getStudentProfileByKey,
  listStudentMemoriesByKey,
  upsertStudentProfileByKey,
  type StudentProfileInput,
} from '@stuflo/db';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';

const STYLE_VALUES = new Set(['concise', 'balanced', 'detailed']);
export class PreferencesInputError extends Error {
  constructor(message: string, readonly code = 'invalid_preferences', readonly status = 400) {
    super(message);
    this.name = 'PreferencesInputError';
  }
}

function requireObject(body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PreferencesInputError('Preferences and memories must be JSON objects.');
  }
}
const MEMORY_CATEGORIES = new Set([
  'preference',
  'goal',
  'course',
  'schedule',
  'accessibility',
  'personal',
  'other',
]);
const STUDY_PREFERENCE_KEYS = new Set([
  'bestStudyTime',
  'sessionLengthMinutes',
  'breakLengthMinutes',
  'preferredExplanationStyle',
  'useExamples',
  'useChecklists',
  'reminderLeadTimeMinutes',
]);

function style(value: unknown) {
  if (typeof value !== 'string' || !STYLE_VALUES.has(value)) throw new PreferencesInputError('Style must be concise, balanced, or detailed.');
  return value as 'concise' | 'balanced' | 'detailed';
}

function safeGoals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((item) => item.slice(0, 200));
}

function safeStudyPreferences(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean | string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!STUDY_PREFERENCE_KEYS.has(key)) continue;
    if (typeof raw === 'boolean') output[key] = raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) output[key] = Math.max(0, raw);
    if (typeof raw === 'string') output[key] = raw.trim().slice(0, 200);
    if (Array.isArray(raw)) {
      output[key] = raw
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 20)
        .map((item) => item.slice(0, 100));
    }
  }
  return output;
}

export async function getPreferences(env: StufloEnv, studentKey: string) {
  const opened = openDatabase(env);
  try {
    const [profile, memories] = await Promise.all([
      getStudentProfileByKey(opened.db, studentKey),
      listStudentMemoriesByKey(opened.db, studentKey, 100),
    ]);
    if (!profile) return null;
    return { profile: profile.profile, memories: memories?.memories ?? [] };
  } finally {
    await opened.close();
  }
}

export async function updatePreferences(
  env: StufloEnv,
  studentKey: string,
  body: Record<string, unknown>,
) {
  requireObject(body);
  const input: StudentProfileInput = {};
  if ('preferredName' in body) {
    if (body.preferredName !== null && typeof body.preferredName !== 'string') throw new PreferencesInputError('Preferred name must be text or null.');
    input.preferredName = typeof body.preferredName === 'string' ? body.preferredName.trim().slice(0, 120) || null : null;
  }
  if ('communicationStyle' in body) input.communicationStyle = style(body.communicationStyle);
  if ('responseVerbosity' in body) input.responseVerbosity = style(body.responseVerbosity);
  if ('learningGoals' in body) {
    if (!Array.isArray(body.learningGoals)) throw new PreferencesInputError('Learning goals must be a list.');
    input.learningGoals = safeGoals(body.learningGoals);
  }
  if ('studyPreferences' in body) {
    if (!body.studyPreferences || typeof body.studyPreferences !== 'object' || Array.isArray(body.studyPreferences)) throw new PreferencesInputError('Study preferences must be an object.');
    input.studyPreferences = safeStudyPreferences(body.studyPreferences);
  }
  if (!Object.keys(input).length) throw new PreferencesInputError('Supply at least one preference to update.');
  const opened = openDatabase(env);
  try {
    return await upsertStudentProfileByKey(opened.db, studentKey, input);
  } finally {
    await opened.close();
  }
}

export async function addMemory(
  env: StufloEnv,
  studentKey: string,
  body: Record<string, unknown>,
  source: 'student' | 'assistant' = 'student',
) {
  requireObject(body);
  const content = typeof body.content === 'string' ? body.content.trim().replace(/\s+/g, ' ') : '';
  const category =
    typeof body.category === 'string' && MEMORY_CATEGORIES.has(body.category)
      ? body.category
      : 'other';
  if (!content || content.length > 1_000) throw new PreferencesInputError('Memory must be 1 to 1,000 characters.', 'invalid_memory');
  const opened = openDatabase(env);
  try {
    try {
      return await createStudentMemoryByKey(opened.db, studentKey, {
        category,
        content,
        source,
        pinned: body.pinned === true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Student memory limit reached.') {
        throw new PreferencesInputError('Memory limit reached. Forget a saved memory before adding another.', 'memory_limit_reached', 409);
      }
      throw error;
    }
  } finally {
    await opened.close();
  }
}

export async function searchMemories(env: StufloEnv, studentKey: string, query: string) {
  const opened = openDatabase(env);
  try {
    const result = await listStudentMemoriesByKey(opened.db, studentKey, 100);
    const active = result?.memories || [];
    const words = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
    const matching = active.map((memory, index) => {
      const text = `${memory.category} ${memory.content}`.toLocaleLowerCase();
      return { memory, index, score: words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0) };
    }).filter((item) => !words.length || item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    return { memories: matching.slice(0, 30).map((item) => item.memory), omitted: Math.max(0, matching.length - 30),
      coverage: `Searched ${active.length} current active memories; returned up to 30 matching items.` };
  } finally {
    await opened.close();
  }
}

export async function removeMemory(env: StufloEnv, studentKey: string, memoryId: string) {
  const opened = openDatabase(env);
  try {
    return await archiveStudentMemoryByKey(opened.db, studentKey, memoryId);
  } finally {
    await opened.close();
  }
}
