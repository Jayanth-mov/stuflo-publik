import { describe, expect, it } from 'vitest';
import { studentLocalTimeContext } from '../src/services/student-time';

describe('student local time context', () => {
  it('uses the student timezone instead of the UTC calendar date', () => {
    const context = studentLocalTimeContext(
      new Date('2026-09-04T02:30:00.000Z'),
      'America/Chicago',
    );
    expect(context).toContain('Current student-local date: 2026-09-03');
    expect(context).toContain('Thursday, September 3, 2026');
    expect(context).toContain('CDT');
  });
});
