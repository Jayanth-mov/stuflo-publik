import { describe, expect, it } from 'vitest';
import { isSimpleMemoryAction, isSimpleMemoryRecall, modelForStuTier, selectStuModelTier } from '../src/model/model-router';

describe('Stu model routing', () => {
  it.each([
    'Find the syllabus for biology in Canvas.',
    'What assignments are due next week?',
    'Explain this research paper and help me build a study guide.',
  ])('keeps academic and Canvas work on Terra: %s', (message) => {
    expect(selectStuModelTier({ message })).toBe('terra');
  });

  it.each([
    'Hey, thanks!',
    'Add a dentist appointment to my calendar tomorrow at 3.',
    'When am I free for a meeting on Friday?',
  ])('routes clearly lightweight work to Luna: %s', (message) => {
    expect(selectStuModelTier({ message })).toBe('luna');
  });

  it('keeps file-backed and long requests on Terra', () => {
    expect(selectStuModelTier({ message: 'Summarize this.', hasAttachmentContext: true })).toBe('terra');
    expect(selectStuModelTier({ message: 'x'.repeat(701) })).toBe('terra');
  });

  it.each([
    'Remember that I prefer 45-minute study sessions after 7 PM.',
    'Please remember my biology class is my favorite course.',
    'Remember my exam is due Friday.',
    'Forget my old assignment preference.',
    'Please forget the old biology course deadline.',
    'What do you remember about my study duration?',
    'What do you know about my preferences?',
    'Show my memories.',
    'QA acceptance: What does your current durable memory say about my study-session length and preferred start time?',
  ])('uses Luna for explicit memory operations: %s', (message) => {
    expect(selectStuModelTier({ message })).toBe('luna');
  });

  it.each([
    'Remember my preferences and check Canvas for my exam deadline.',
    'Forget my old deadline. When is my next assignment due?',
    'Remember what the syllabus says about late work?',
    'What do you remember about my assignments?',
    'What do you remember about my tests?',
    'QA acceptance: What does your durable memory say about my next exam deadline?',
    'Recall my preferences and compare them with my class calendar.',
  ])('preserves academic retrieval for combined memory requests: %s', (message) => {
    expect(selectStuModelTier({ message })).toBe('terra');
  });

  it('keeps attachments and long explicit memory actions on the academic tier', () => {
    expect(selectStuModelTier({ message: 'Remember this file.', hasAttachmentContext: true })).toBe('terra');
    expect(selectStuModelTier({ message: `Remember ${'a'.repeat(700)}` })).toBe('terra');
  });

  it('exports a conservative memory-only context guard without accepting attached or academic requests', () => {
    const recall = 'What does your current durable memory say about my study-session length?';
    expect(isSimpleMemoryRecall(recall)).toBe(true);
    expect(isSimpleMemoryRecall(recall, true)).toBe(false);
    expect(isSimpleMemoryRecall(`${recall} ${'a'.repeat(700)}`)).toBe(false);
    expect(isSimpleMemoryRecall('What does your current durable memory say about my exam deadline?')).toBe(false);
    expect(isSimpleMemoryRecall('What do you remember about my preferences, and check my calendar for Friday?')).toBe(false);
    expect(isSimpleMemoryRecall('Recall my preferences. Then find a good study time.')).toBe(false);
  });

  it.each([
    'Remember that I prefer evening study and schedule a study block tomorrow.',
    'Remember my preference. Schedule a study block tomorrow.',
    'Remember my preference, schedule a study block tomorrow.',
    'Remember my preference; please remind me tomorrow.',
    'Remember my preference and could you create a calendar event tomorrow.',
    'Remember my preference and I need you to schedule a study block tomorrow.',
    'Remember my preference and I would like to schedule a study block tomorrow.',
    'Remember my preference and can we schedule a study block tomorrow.',
    'Remember my preference and put a study block on my calendar tomorrow.',
    'Remember my preference\nCreate a study block tomorrow.',
  ])('rejects additional requests before limiting context to memory: %s', (message) => {
    expect(isSimpleMemoryAction(message)).toBe(false);
  });

  it.each([
    'Show my memories and add a meeting to my calendar tomorrow.',
    'What do you remember about me, and when am I free tomorrow?',
    'Recall my preferences; please schedule a study block tomorrow.',
  ])('keeps combined memory recall and calendar tasks outside memory-only context: %s', (message) => {
    expect(isSimpleMemoryRecall(message)).toBe(false);
  });

  it('allows calendar-related stored content without treating it as an event mutation request', () => {
    const storedFact = 'Remember my calendar appointment is Friday at 3 PM.';
    expect(isSimpleMemoryAction(storedFact)).toBe(true);
    expect(isSimpleMemoryAction(storedFact, true)).toBe(false);
    expect(selectStuModelTier({ message: storedFact })).toBe('luna');
  });

  it('keeps the original acceptance preference and its future cleanup narrative on Luna', () => {
    const message = 'Remember this test-only preference in durable memory: QA-2026-10-02, I prefer 45-minute study sessions after 7 PM. We will forget this after the acceptance test.';
    expect(isSimpleMemoryAction(message)).toBe(true);
    expect(selectStuModelTier({ message })).toBe('luna');
  });

  it('defaults to exact deployed GPT 6 models without implying Terra 6 access', () => {
    expect(modelForStuTier('luna')).toBe('gpt-6-luna');
    expect(modelForStuTier('terra')).toBe('gpt-6-sol');
  });

  it('resolves explicit deployment model overrides', () => {
    expect(modelForStuTier('luna', { lunaModel: 'openai/luna-custom' })).toBe('openai/luna-custom');
    expect(modelForStuTier('terra', { terraModel: 'openai/terra-custom' })).toBe('openai/terra-custom');
  });
});
