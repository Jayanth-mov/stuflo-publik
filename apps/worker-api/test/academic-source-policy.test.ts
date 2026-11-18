import { describe, expect, it } from 'vitest';
import { ACADEMIC_SOURCE_POLICY } from '../src/academic-source-policy';

describe('academic source policy', () => {
  it('requires syllabus-first interpretation with version-aware Canvas reconciliation', () => {
    expect(ACADEMIC_SOURCE_POLICY).toContain('the first evidence source must be the current saved syllabus');
    expect(ACADEMIC_SOURCE_POLICY).toContain('newer instructor announcement or item-specific Canvas update may override it');
    expect(ACADEMIC_SOURCE_POLICY).toContain('nominal Canvas due_at timestamp');
    expect(ACADEMIC_SOURCE_POLICY).toContain('grace period');
    expect(ACADEMIC_SOURCE_POLICY).toContain('newest updatedAt value');
    expect(ACADEMIC_SOURCE_POLICY).toContain('first use the syllabus to identify the named instructor');
    expect(ACADEMIC_SOURCE_POLICY).toContain('posts by a TA describe TA information unless they clearly say otherwise');
    expect(ACADEMIC_SOURCE_POLICY).toContain('If Canvas omits authorName, say the poster is unknown');
    expect(ACADEMIC_SOURCE_POLICY).toContain('exact student-local date');
    expect(ACADEMIC_SOURCE_POLICY).toContain('surrounding week');
    expect(ACADEMIC_SOURCE_POLICY).toContain('current-student submission or grading state');
    expect(ACADEMIC_SOURCE_POLICY).toContain('off-Canvas work in systems such as Ed, zyBooks');
    expect(ACADEMIC_SOURCE_POLICY).toContain('all-courses workload question');
  });
});
