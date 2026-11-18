import { describe, expect, it, vi } from 'vitest';
import { CanvasAdapter, type FetchLike } from '../src';

const connection = {
  canvasHost: 'school.instructure.com',
  cookies: [{ name: 'canvas_session', value: 'secret', domain: 'school.instructure.com' }],
  timeZone: 'America/Chicago',
};

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function fixtureFetch(): FetchLike {
  return vi.fn(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/users/self/profile') return json({ id: 7, name: 'Student' });
    if (url.pathname === '/api/v1/courses') {
      if (url.searchParams.get('enrollment_state') === 'completed') {
        return json([{ id: 30, name: 'Chemistry 2025', course_code: 'CH 301', workflow_state: 'completed', term: { name: 'Fall 2025' } }]);
      }
      return json([
        {
          id: 10,
          name: 'Biology',
          enrollments: [{ type: 'student', computed_current_score: 92.5, computed_current_grade: 'A' }],
        },
        { id: 20, name: 'History', enrollments: [] },
      ]);
    }
    if (url.pathname === '/api/v1/courses/10/assignments') {
      return json([
         {
           id: 101,
           name: 'Lab report',
           due_at: '2026-08-08T04:00:00Z',
           unlock_at: '2026-08-01T05:00:00Z',
           lock_at: '2026-08-10T04:00:00Z',
           points_possible: 25,
           submission: { submitted_at: null, attempt: 0, score: null, grade: null },
         },
      ]);
    }
    if (url.pathname === '/api/v1/courses/20/assignments') {
      return json([{ id: 201, name: 'Essay', due_at: null, submission: { missing: true } }]);
    }
    if (url.pathname === '/api/v1/courses/10/discussion_topics') {
      if (!url.searchParams.has('only_announcements')) {
        return json([
          { id: 302, title: 'Questions', message: '<p>Ask here</p>', unread_count: 2 },
          {
            id: 301,
            title: 'Welcome',
            message: '<p>Hello <strong>class</strong>.</p>',
            is_announcement: true,
            user_id: 55,
            user_name: 'Joshua Lee',
          },
        ]);
      }
      return json([
        {
          id: 301,
          title: 'Welcome',
          posted_at: '2026-08-01T12:00:00Z',
          message: '<p>Hello <strong>class</strong>.</p>',
          user_id: 55,
          user_name: 'Joshua Lee',
        },
      ]);
    }
    if (url.pathname === '/api/v1/courses/20/discussion_topics') {
      return json({ error: 'disabled' }, { status: 403 });
    }
    if (url.pathname === '/api/v1/courses/10/pages') {
      return json([{ url: 'syllabus-overview', title: 'Syllabus overview', front_page: true, published: true }]);
    }
    if (url.pathname === '/api/v1/courses/20/pages') return json([]);
    if (url.pathname === '/api/v1/courses/10/pages/syllabus-overview') {
      return json({
        url: 'syllabus-overview',
        title: 'Syllabus overview',
        body: '<p>Read chapter one.</p><a href="/courses/10/files/88">PDF</a><a href="https://example.edu/biology">Class Website</a>',
        published: true,
      });
    }
    if (url.pathname === '/api/v1/courses/10/tabs') {
      return json([{ id: 'syllabus', label: 'Syllabus', html_url: '/courses/10/assignments/syllabus' }]);
    }
    if (url.pathname === '/api/v1/courses/10/external_tools/sessionless_launch') {
      return json({ id: 122213, name: 'UT Simple Syllabus', url: 'https://syllabus.example.edu/launch/one-time' });
    }
    if (url.pathname === '/api/v1/courses/10/modules') {
      return json([{ id: 7, name: 'Start Here', items: [
        { id: 8, title: 'Course Syllabus', type: 'File', content_id: 88 },
        { id: 9, title: 'Course Website', type: 'ExternalUrl', external_url: 'https://example.edu/course-outline' },
      ] }]);
    }
    if (url.pathname === '/api/v1/courses/10/files') {
      return json([{ id: 88, display_name: 'Syllabus.pdf', 'content-type': 'application/pdf', size: 18, url: 'https://school.instructure.com/files/88/download' }]);
    }
    if (url.pathname === '/api/v1/courses/20/files') return json([]);
    if (url.pathname === '/api/v1/courses/10/quizzes') {
      return json([{ id: 55, title: 'Quiz 1', due_at: '2026-08-09T04:00:00Z', question_count: 10 }]);
    }
    if (url.pathname === '/api/v1/courses/20/quizzes') return json([]);
    if (url.pathname === '/api/v1/users/self/todo') {
      return json([{ type: 'submitting', course_id: 10, assignment: { id: 101, name: 'Lab report', due_at: '2026-08-08T04:00:00Z' } }]);
    }
    if (url.pathname === '/api/v1/courses/10/assignments/101') {
      return json({
        id: 101,
        name: 'Lab report',
        description: '<p>Upload the report and review the <a href="https://example.edu/lab-guide">lab guide</a>.</p>',
        due_at: '2026-08-08T04:00:00Z',
        unlock_at: '2026-08-01T05:00:00Z',
        lock_at: '2026-08-10T04:00:00Z',
        points_possible: 25,
        assignment_group_id: 4,
        position: 2,
        published: true,
        omit_from_final_grade: false,
        allowed_attempts: 3,
        has_submitted_submissions: true,
        group_category_id: 8,
        grade_group_students_individually: true,
        peer_reviews: true,
        automatic_peer_reviews: true,
        anonymous_peer_reviews: false,
        submission_types: ['online_upload', 'external_tool'],
        allowed_extensions: ['pdf', 'docx'],
        grading_type: 'points',
        external_tool_tag_attributes: {
          url: 'https://ed.example.edu/lesson/1',
          new_tab: true,
          resource_link_id: 'ed-pa1',
        },
        all_dates: [
          {
            id: 900,
            title: 'Section 1',
            base: false,
            due_at: '2026-08-08T04:00:00Z',
            unlock_at: '2026-08-01T05:00:00Z',
            lock_at: '2026-08-10T04:00:00Z',
          },
        ],
        rubric_settings: {
          title: 'Lab rubric',
          points_possible: 25,
          free_form_criterion_comments: true,
          hide_score_total_outcome: false,
        },
        rubric: [{
          id: 'quality',
          description: 'Quality',
          long_description: '<p>Explain the results clearly.</p>',
          points: 25,
          ratings: [{ id: 'excellent', description: 'Excellent', points: 25 }],
        }],
      });
    }
    if (url.pathname === '/api/v1/courses/10/assignments/101/submissions/self') {
      return json({
        id: 701,
        workflow_state: 'graded',
        submitted_at: '2026-08-08T02:00:00Z',
        graded_at: '2026-08-09T18:00:00Z',
        attempt: 1,
        score: 23,
        grade: '23',
        entered_score: 23,
        entered_grade: '23',
        submission_type: 'online_upload',
        late: false,
        missing: false,
        excused: false,
        attachments: [{
          id: 702,
          display_name: 'lab-report.pdf',
          'content-type': 'application/pdf',
          size: 1234,
          url: 'https://school.instructure.com/files/702/download',
          preview_url: 'https://school.instructure.com/files/702/preview',
        }],
        submission_comments: [{
          id: 703,
          author_id: 55,
          author_name: 'Professor Rivera',
          comment: '<p>Strong analysis.</p>',
          created_at: '2026-08-09T18:05:00Z',
        }],
        rubric_assessment: {
          quality: { points: 23, rating_id: 'excellent', comments: 'Clear work.' },
        },
      });
    }
    if (url.pathname === '/api/v1/files/88') {
      return json({ id: 88, context_id: 10, context_type: 'Course', display_name: 'Syllabus.pdf', 'content-type': 'application/pdf', size: 18, url: 'https://school.instructure.com/files/88/download' });
    }
    if (url.pathname === '/files/88/download') {
      return new Response(new TextEncoder().encode('fake syllabus pdf'), { headers: { 'content-type': 'application/pdf' } });
    }
    if (url.pathname === '/api/v1/calendar_events') {
      if (url.searchParams.get('type') === 'assignment') {
        return json([{ id: 501, context_code: 'course_10', start_at: '2026-08-12T15:00:00Z', assignment: { id: 101, name: 'Lab report', html_url: 'https://school.instructure.com/courses/10/assignments/101' } }]);
      }
      return json([{ id: 500, title: 'Biology lecture', context_code: 'course_10', start_at: '2026-08-11T15:00:00Z', end_at: '2026-08-11T16:00:00Z', location_name: 'Science 101' }]);
    }
    if (url.pathname === '/api/v1/courses/10') {
      return json({ id: 10, name: 'Biology', syllabus_body: '<p>Official policies.</p><a href="/courses/10/files/88">Syllabus PDF</a>', default_view: 'wiki' });
    }
    return json({ error: 'not found' }, { status: 404 });
  });
}

describe('CanvasAdapter', () => {
  it('shares in-flight course reads but refreshes the catalog after completion', async () => {
    const fetcher = vi.fn().mockResolvedValue(json([{ id: 10, name: 'Biology' }]));
    const adapter = new CanvasAdapter(connection, { fetch: fetcher });
    await Promise.all([adapter.listCourses(), adapter.listGrades()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(json([{ id: 20, name: 'History' }]));
    const later = await adapter.listCourses();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(later.data[0].id).toBe('20');
  });

  it('keeps citation links when Canvas omits announcement html_url', async () => {
    const result = await new CanvasAdapter(connection, { fetch: fixtureFetch() }).listAnnouncements();
    expect(result.data[0].url).toBe('https://school.instructure.com/courses/10/discussion_topics/301');
  });

  it('provides the verified local weekday and year for announcements instead of relying on model date arithmetic', async () => {
    const base = fixtureFetch();
    const fetcher: FetchLike = async (input, init) => new URL(String(input)).pathname.endsWith('/10/discussion_topics')
      ? json([{ id: 5836799, title: 'Reading', posted_at: '2026-09-22T20:30:00Z' }]) : base(input, init);
    const result = await new CanvasAdapter(connection, { fetch: fetcher }).listAnnouncements();
    expect(result.data[0]).toMatchObject({ postedAt: '2026-09-22T20:30:00Z' });
    expect(result.data[0].postedAtLocal).toContain('Tuesday');
    expect(result.data[0].postedAtLocal).toContain('Sep 22, 2026');
    expect(result.data[0].postedAtLocal).toContain('3:30 PM CDT');
  });

  it('does not save an HTML login or error page as a PDF course file', async () => {
    const base = fixtureFetch();
    const fetcher: FetchLike = async (input, init) => new URL(String(input)).pathname === '/files/88/download'
      ? new Response('<html>Login required</html>', { headers: { 'content-type': 'text/html' } }) : base(input, init);
    await expect(new CanvasAdapter(connection, { fetch: fetcher }).downloadFile('10', '88')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    [{ workflow_state: 'submitted' }, 'submitted'],
    [{ workflow_state: 'pending_review' }, 'submitted'],
    [{ workflow_state: 'graded', missing: true }, 'missing'],
    [{ graded_at: '2026-10-01T00:00:00Z', missing: true }, 'missing'],
    [{ workflow_state: 'graded', submitted_at: '2026-10-01T00:00:00Z', missing: true }, 'graded'],
    [{ workflow_state: 'submitted', graded_at: '2026-10-01T00:00:00Z' }, 'submitted'],
    [{ workflow_state: 'pending_review', graded_at: '2026-10-01T00:00:00Z' }, 'submitted'],
    [{ submitted_at: '2026-10-01T00:00:00Z', missing: true }, 'submitted'],
    [{ workflow_state: 'submitted', missing: true, late: true }, 'late'],
    [{ workflow_state: 'unsubmitted', missing: true, late: true }, 'missing'],
    [{ workflow_state: 'graded', excused: true }, 'excused'],
    [{ workflow_state: 'unsubmitted' }, 'unsubmitted'],
  ])('uses submission evidence ahead of stale missing flags: %j', async (submission, expected) => {
    const fetcher = vi.fn(async (input) => new URL(String(input)).pathname === '/api/v1/courses'
      ? json([{ id: 10, name: 'Biology' }]) : json([{ id: 101, name: 'Report', submission }]));
    const result = await new CanvasAdapter(connection, { fetch: fetcher }).listAssignments();
    expect(result.data[0].submissionStatus).toBe(expected);
  });

  it('compares assignment dates by instants across timezone offsets and includes exact bounds', async () => {
    const fetcher = vi.fn(async (input) => new URL(String(input)).pathname === '/api/v1/courses'
      ? json([{ id: 10, name: 'Biology' }]) : json([
        { id: 101, due_at: '2026-10-03T01:00:00+02:00' },
        { id: 102, due_at: '2026-10-02T19:00:00-05:00' },
        { id: 103, due_at: '2026-10-02T20:00:00-05:00' },
      ]));
    const result = await new CanvasAdapter(connection, { fetch: fetcher }).listAssignments({
      dueAfter: '2026-10-02T23:00:00Z', dueBefore: '2026-10-03T00:00:00Z', includeUndated: false,
    });
    expect(result.data.map((item) => item.id)).toEqual(['101', '102']);
  });

  it.each([{ dueAfter: 'garbage' }, { dueBefore: 'garbage' }, { dueAfter: '2026-10-03T00:00:00Z', dueBefore: '2026-10-02T00:00:00Z' }])('rejects invalid assignment date bounds before fetching', async (bounds) => {
    const fetcher = fixtureFetch();
    await expect(new CanvasAdapter(connection, { fetch: fetcher }).listAssignments(bounds)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not accept an empty profile as proof of a signed-in session', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: vi.fn().mockResolvedValue(json({})) });
    await expect(adapter.validateSession()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('validates a cookie session without a browser', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    await expect(adapter.validateSession()).resolves.toMatchObject({
      data: { connected: true, userId: '7', userName: 'Student' },
      warnings: [],
    });
  });

  it('normalizes and sorts assignments', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.listAssignments();
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: '101',
      courseId: '10',
      course: 'Biology',
      submissionStatus: 'unsubmitted',
      unlockAt: '2026-08-01T05:00:00Z',
      lockAt: '2026-08-10T04:00:00Z',
      submission: expect.objectContaining({ attempt: 0, score: null, grade: null }),
    });
    expect(result.data[0].dueAtLocal).toContain('Aug 7');
    expect(result.data[1]).toMatchObject({ id: '201', submissionStatus: 'missing', dueAt: null });
  });

  it('returns full student-safe assignment, submission, feedback, and rubric details', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.getAssignmentDetail('10', '101');
    expect(result.warnings).toEqual([]);
    expect(result.data).toMatchObject({
      id: '101',
      assignmentGroupId: '4',
      allowedAttempts: 3,
      unlockAt: '2026-08-01T05:00:00Z',
      lockAt: '2026-08-10T04:00:00Z',
      submissionStatus: 'graded',
      submissionTypes: ['online_upload', 'external_tool'],
      groupAssignment: { groupCategoryId: '8', gradeGroupStudentsIndividually: true },
      peerReview: { enabled: true, automatic: true, anonymous: false },
      externalTool: {
        url: 'https://ed.example.edu/lesson/1',
        newTab: true,
        resourceLinkId: 'ed-pa1',
      },
      dates: [expect.objectContaining({ id: '900', title: 'Section 1' })],
      rubric: [expect.objectContaining({
        id: 'quality',
        ratings: [expect.objectContaining({ id: 'excellent', points: 25 })],
      })],
      submission: expect.objectContaining({
        id: '701',
        attempt: 1,
        score: 23,
        grade: '23',
        attachments: [expect.objectContaining({ id: '702', name: 'lab-report.pdf' })],
        comments: [expect.objectContaining({ authorName: 'Professor Rivera', comment: 'Strong analysis.' })],
        rubricAssessment: [expect.objectContaining({ criterionId: 'quality', points: 23 })],
      }),
    });
    expect(result.data.description).toContain('Upload the report');
    expect(result.data.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://example.edu/lab-guide' }),
    ]));
  });

  it('normalizes grades from course enrollments', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.listGrades();
    expect(result.data[0]).toMatchObject({ currentScore: 92.5, currentGrade: 'A' });
    expect(result.data[1]).toMatchObject({ currentScore: null, currentGrade: null });
  });

  it('catalogs completed courses separately and refreshes later active-course requests', async () => {
    const fetcher = fixtureFetch();
    const adapter = new CanvasAdapter(connection, { fetch: fetcher });
    await expect(adapter.listCompletedCourses()).resolves.toMatchObject({
      data: [expect.objectContaining({ id: '30', name: 'Chemistry 2025', courseCode: 'CH 301', termName: 'Fall 2025' })],
    });
    await adapter.listCourses();
    await adapter.listGrades();
    const courseCalls = (fetcher as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/api/v1/courses');
    expect(courseCalls.filter((url) => url.searchParams.get('enrollment_state') === 'active')).toHaveLength(2);
    expect(courseCalls.filter((url) => url.searchParams.get('enrollment_state') === 'completed')).toHaveLength(1);
  });

  it('returns successful course data with partial-failure warnings', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.listAnnouncements();
    expect(result.data).toEqual([
      expect.objectContaining({
        title: 'Welcome',
        message: 'Hello class.',
        authorId: '55',
        authorName: 'Joshua Lee',
      }),
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'permission_denied', courseId: '20' }),
    ]);
  });

  it('navigates pages, discussions, files, quizzes, and the Canvas to-do list', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    await expect(adapter.listPages('10')).resolves.toMatchObject({
      data: [expect.objectContaining({ pageUrl: 'syllabus-overview', frontPage: true })],
    });
    await expect(adapter.getPage('10', 'syllabus-overview')).resolves.toMatchObject({
      data: expect.objectContaining({ body: expect.stringContaining('Read chapter one. PDF'), linkedFiles: [expect.stringContaining('/files/88')] }),
    });
    await expect(adapter.listDiscussions('10')).resolves.toMatchObject({
      data: [expect.objectContaining({ title: 'Questions', unreadCount: 2 })],
    });
    await expect(adapter.listFiles('10')).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'Syllabus.pdf', sizeBytes: 18 })],
    });
    await expect(adapter.listQuizzes('10')).resolves.toMatchObject({
      data: [expect.objectContaining({ title: 'Quiz 1', questionCount: 10 })],
    });
    await expect(adapter.listTodos()).resolves.toMatchObject({
      data: [expect.objectContaining({ title: 'Lab report', courseId: '10' })],
    });
  });

  it('gets an HTTPS sessionless launch URL for a course navigation tool', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    await expect(adapter.getExternalToolLaunch('10', '122213')).resolves.toMatchObject({
      data: {
        id: '122213',
        name: 'UT Simple Syllabus',
        url: 'https://syllabus.example.edu/launch/one-time',
      },
    });
  });

  it('discovers syllabi across the native syllabus, home page, modules, tabs, and files', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.findSyllabus('10');
    expect(result.data.found).toBe(true);
    expect(result.data.searched).toContain('course home page');
    expect(result.data.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'canvas_syllabus', confidence: 100 }),
        expect.objectContaining({ kind: 'file', fileId: '88' }),
        expect.objectContaining({ kind: 'module_item', fileId: '88' }),
        expect.objectContaining({ kind: 'module_item', url: 'https://example.edu/course-outline' }),
        expect.objectContaining({ kind: 'external_link', url: 'https://example.edu/biology' }),
      ]),
    );
  });

  it('downloads an authorized course file without forwarding cookies off-host', async () => {
    const fetcher = fixtureFetch();
    const adapter = new CanvasAdapter(connection, { fetch: fetcher });
    const result = await adapter.downloadFile('10', '88');
    expect(result.data.file).toMatchObject({ name: 'Syllabus.pdf', contentType: 'application/pdf' });
    expect(new TextDecoder().decode(result.data.bytes)).toBe('fake syllabus pdf');
    const downloadCall = (fetcher as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => new URL(String(input)).pathname === '/files/88/download');
    expect(downloadCall?.[1]?.headers.cookie).toBe('canvas_session=secret');
  });

  it('reads a public linked course website without Canvas credentials', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('<html><body>External syllabus</body></html>', {
      headers: { 'content-type': 'text/html' },
    }));
    const adapter = new CanvasAdapter(connection, { fetch: fetcher });
    const result = await adapter.downloadExternalResource('https://example.edu/biology');
    expect(result.data.file).toMatchObject({ name: 'biology.html', contentType: 'text/html' });
    expect(new TextDecoder().decode(result.data.bytes)).toContain('External syllabus');
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).cookie).toBeUndefined();
  });

  it('reads Canvas calendar events and assignment dates', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.getSchedule({
      startDate: '2026-08-10',
      endDate: '2026-08-16',
      courseId: '10',
    });
    expect(result.data).toEqual([
      expect.objectContaining({ type: 'event', title: 'Biology lecture', course: 'Biology' }),
      expect.objectContaining({ type: 'assignment', title: 'Lab report', courseId: '10' }),
    ]);
  });

  it('searches across course content instead of relying on grades and course names', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.searchCourse('syllabus', '10');
    expect(result.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'page', title: 'Syllabus overview' }),
        expect.objectContaining({ kind: 'file', fileId: '88' }),
        expect.objectContaining({ kind: 'tab', title: 'Syllabus' }),
      ]),
    );
  });

  it('preserves announcement authors in course search results', async () => {
    const adapter = new CanvasAdapter(connection, { fetch: fixtureFetch() });
    const result = await adapter.searchCourse('welcome', '10');
    expect(result.data.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'announcement',
        title: 'Welcome',
        authorId: '55',
        authorName: 'Joshua Lee',
      }),
    ]));
  });
});
