import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalUsageBudgetExceededError } from '@stuflo/usage';

const mocks = vi.hoisted(() => ({ preflight: vi.fn(), record: vi.fn() }));
vi.mock('../src/services/usage', () => ({ preflightStudentUsage: mocks.preflight, recordStuAgentUsage: mocks.record }));
import { gradeModelEval, handleAdminModelEval, parseModelEvalInput, runSyntheticModelEval } from '../src/services/model-evals';
import { ModelProviderError, OpenAiModelGateway } from '../src/model/model-gateway';
import type { ModelCompletion, ModelGateway } from '../src/model/model-gateway';
import type { AuthenticatedSession } from '../src/services/admin-authorization';
import type { StufloEnv } from '../src/env';

const env = { ADMIN_EMAILS: 'Admin@Example.com', OPENAI_API_KEY: 'test-key' } as StufloEnv;
const session = { email: 'admin@example.com', studentKey: 'student_test', userId: 'user_test' } as AuthenticatedSession;
const completed = (content: string, names: string[] = []): ModelCompletion => ({ content, toolCalls: names.map((name, index) => ({ id: `call-${index}`, type: 'function', function: { name, arguments: '{}' } })), provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 100, outputTokens: 20 }, durationMs: 1 });
const valid = { model: 'gpt-6-luna', effort: 'low', caseId: 'next_due' };

describe('bounded admin model evaluations', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); mocks.preflight.mockResolvedValue({ student: { id: 'student-id' } }); mocks.record.mockResolvedValue({ charge: { creditsCharged: 0.001 } }); });

  it.each([null, [], {}, { ...valid, prompt: 'Arbitrary prompt' }, { ...valid, model: 'gpt-6-terra-fake' }, { ...valid, effort: 'max' }, { ...valid, caseId: '__proto__' }, { ...valid, cachePrefix: 'Arbitrary prefix' }, { ...valid, cachePrefix: 1 }, { ...valid, cachePrefix: {} }])('rejects unbounded or invalid request input: %j', (raw) => {
    expect(parseModelEvalInput(raw)).toBeNull();
  });

  it('keeps the exact requested Terra 6 identifier for an explicit availability check', () => {
    expect(parseModelEvalInput({ ...valid, model: 'gpt-6-terra' })).toMatchObject({ model: 'gpt-6-terra' });
  });

  it('allows only a boolean opt-in for the bounded synthetic cache-prefix probe', async () => {
    expect(parseModelEvalInput({ ...valid, cachePrefix: true })).toEqual({ ...valid, cachePrefix: true });
    vi.spyOn(OpenAiModelGateway.prototype, 'complete').mockResolvedValue(completed('Synthetic reply.'));
    const result = await handleAdminModelEval(env, session, { ...valid, cachePrefix: true });
    expect(result.body).toMatchObject({ evalVersion: '2026-10-02-v4-cache-prefix-probe', cachePrefix: true, cacheProbe: { firstCompletionUsage: { inputTokens: 100, outputTokens: 20 } } });
    expect(JSON.stringify(result.body)).not.toContain('test-key');
  });

  it('rejects unauthenticated and non-admin callers before calling any model or charging credits', async () => {
    const complete = vi.spyOn(OpenAiModelGateway.prototype, 'complete');
    expect(await handleAdminModelEval(env, null, valid)).toMatchObject({ status: 401 });
    expect(await handleAdminModelEval(env, { ...session, email: 'student@example.com' }, valid)).toMatchObject({ status: 403 });
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('enforces global budgets before invoking the model', async () => {
    const complete = vi.spyOn(OpenAiModelGateway.prototype, 'complete');
    mocks.preflight.mockRejectedValue(new GlobalUsageBudgetExceededError('daily'));
    await expect(handleAdminModelEval(env, session, valid)).rejects.toMatchObject({ code: 'global_ai_budget_exceeded' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('reports model unavailability without exposing provider error messages or secrets', async () => {
    vi.spyOn(OpenAiModelGateway.prototype, 'complete').mockRejectedValue(new ModelProviderError(404, 'model_not_found', 'secret provider details'));
    const result = await handleAdminModelEval(env, session, { ...valid, model: 'gpt-6-terra' });
    expect(result.body).toMatchObject({ availability: 'unavailable', model: 'gpt-6-terra', error: 'model_unavailable' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('records every successful completion, including work before a later model failure', async () => {
    vi.spyOn(OpenAiModelGateway.prototype, 'complete').mockResolvedValueOnce(completed('', ['canvas_get_assignments'])).mockRejectedValueOnce(new Error('provider failure'));
    expect(await handleAdminModelEval(env, session, valid)).toMatchObject({ body: { availability: 'request_failed', usage: { creditsCharged: 0.001 } } });
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(env, expect.objectContaining({ operation: 'model.eval', completions: [expect.objectContaining({ usage: { inputTokens: 100, outputTokens: 20 } })] }));
  });

  it('requires accurate answers, source reads, citations and concise wording together', () => {
    const reply = 'Your next item is the Marketing Quiz, today at 6 PM CDT. [Canvas](https://canvas.example.edu/courses/10/assignments/101)';
    expect(gradeModelEval('next_due', reply, ['canvas_get_assignments', 'calendar_list_events']).passed).toBe(true);
    expect(gradeModelEval('next_due', reply, ['canvas_get_assignments']).passed).toBe(false);
    expect(gradeModelEval('next_due', 'Marketing Quiz, 6 PM.', ['canvas_get_assignments', 'calendar_list_events']).passed).toBe(false);
  });

  it('accepts accurate concise wording without forcing irrelevant source citations', () => {
    const reply = 'Marketing Quiz deadline extended to October 3 at 6 PM. [Current Canvas](https://canvas.example.edu/courses/10/assignments/101) conflicts with the old [calendar](https://calendar.google.com/calendar/event?eid=synthetic).';
    expect(gradeModelEval('deadline_conflict', reply, ['canvas_get_assignments', 'calendar_list_events', 'canvas_read_saved_resource', 'canvas_get_announcements']).passed).toBe(true);
    expect(gradeModelEval('memory_preference', 'Study 7:30–8:15 PM for a 45-minute session. [Canvas](https://canvas.example.edu/courses/10/assignments/101) [Calendar](https://calendar.google.com/calendar/event?eid=synthetic)', ['canvas_get_assignments', 'calendar_list_events']).passed).toBe(true);
  });

  it('returns isolated fixed source evidence through the tool loop', async () => {
    const complete = vi.fn().mockResolvedValueOnce(completed('', ['canvas_get_assignments', 'calendar_list_events'])).mockResolvedValueOnce(completed('Marketing Quiz, 6 PM. [Canvas](https://canvas.example.edu/courses/10/assignments/101)'));
    const result = await runSyntheticModelEval({ complete } as ModelGateway, 'next_due');
    expect(result.grade.passed).toBe(true);
    expect(result.completions).toHaveLength(2);
    expect(complete.mock.calls[1][0].messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(2);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(env.OPENAI_API_KEY!);
  });
});
