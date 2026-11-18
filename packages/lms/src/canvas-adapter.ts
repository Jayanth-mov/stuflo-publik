import { CanvasError, asCanvasError } from './errors';
import { CanvasHttpClient, type CanvasHttpOptions } from './http';
import {
  canvasFileIdFromUrl,
  extractCanvasFileLinks,
  extractResourceLinks,
  htmlToText,
} from './text';
import { toLocal } from './timezone';
import type {
  Announcement,
  AnnouncementQuery,
  Assignment,
  AssignmentDetail,
  AssignmentQuery,
  AssignmentSubmissionDetail,
  AssignmentSubmissionSummary,
  CanvasAssignmentDate,
  CanvasCourseSearch,
  CanvasConnection,
  CanvasDiscussion,
  CanvasExternalToolLaunch,
  CanvasFileDownload,
  CanvasFileSummary,
  CanvasPageDetail,
  CanvasPageSummary,
  CanvasQuizSummary,
  CanvasResourceLink,
  CanvasScheduleItem,
  CanvasScheduleQuery,
  CanvasSearchResult,
  CanvasSyllabusCandidate,
  CanvasSyllabusDiscovery,
  CanvasTab,
  CanvasTodoItem,
  Course,
  CourseGrade,
  CourseModule,
  CourseOverview,
  CourseSyllabus,
  LmsAdapter,
  LmsResult,
  LmsWarning,
  ModuleItem,
  SessionStatus,
  SubmissionStatus,
} from './types';

interface CanvasEnrollment {
  type?: string;
  role?: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
  computed_current_letter_grade?: string | null;
}

interface CanvasCourse {
  id?: string | number;
  name?: string;
  course_code?: string;
  workflow_state?: string;
  start_at?: string | null;
  end_at?: string | null;
  enrollments?: CanvasEnrollment[];
  syllabus_body?: string | null;
  default_view?: string;
  term?: { name?: string };
  teachers?: Array<{ id?: string | number; name?: string; display_name?: string }>;
}

interface CanvasSubmission {
  id?: string | number;
  missing?: boolean;
  late?: boolean;
  excused?: boolean;
  workflow_state?: string;
  graded_at?: string | null;
  submitted_at?: string | null;
  attempt?: number | null;
  score?: number | null;
  grade?: string | null;
  entered_score?: number | null;
  entered_grade?: string | null;
  submission_type?: string | null;
  body?: string | null;
  url?: string | null;
  preview_url?: string | null;
  seconds_late?: number | null;
  late_policy_status?: string | null;
  attachments?: CanvasFile[];
  submission_comments?: Array<{
    id?: string | number;
    author_id?: string | number | null;
    author_name?: string | null;
    author?: { id?: string | number | null; display_name?: string | null } | null;
    comment?: string | null;
    created_at?: string | null;
    edited_at?: string | null;
  }>;
  rubric_assessment?: Record<string, {
    points?: number | null;
    rating_id?: string | number | null;
    comments?: string | null;
  }>;
}

interface CanvasAssignment {
  id?: string | number;
  name?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  description?: string | null;
  submission_types?: string[];
  submission?: CanvasSubmission;
  allowed_extensions?: string[];
  grading_type?: string;
  assignment_group_id?: string | number | null;
  position?: number | null;
  published?: boolean;
  omit_from_final_grade?: boolean;
  allowed_attempts?: number | null;
  has_submitted_submissions?: boolean;
  locked_for_user?: boolean;
  lock_explanation?: string | null;
  group_category_id?: string | number | null;
  grade_group_students_individually?: boolean;
  peer_reviews?: boolean;
  automatic_peer_reviews?: boolean;
  anonymous_peer_reviews?: boolean;
  external_tool_tag_attributes?: {
    url?: string | null;
    new_tab?: boolean;
    resource_link_id?: string | null;
  } | null;
  all_dates?: Array<{
    id?: string | number | null;
    title?: string | null;
    base?: boolean;
    due_at?: string | null;
    unlock_at?: string | null;
    lock_at?: string | null;
  }>;
  rubric_settings?: {
    title?: string | null;
    points_possible?: number | null;
    free_form_criterion_comments?: boolean;
    hide_score_total_outcome?: boolean;
  } | null;
  rubric?: Array<{
    id?: string | number;
    description?: string;
    long_description?: string;
    points?: number;
    ratings?: Array<{
      id?: string | number;
      description?: string;
      long_description?: string;
      points?: number;
    }>;
  }>;
}

interface CanvasAnnouncement {
  id?: string | number;
  title?: string;
  posted_at?: string;
  created_at?: string;
  message?: string;
  html_url?: string;
  user_id?: string | number | null;
  user_name?: string | null;
  author?: {
    id?: string | number | null;
    display_name?: string | null;
  } | null;
}

interface CanvasModuleItem {
  id?: string | number;
  title?: string;
  type?: string;
  position?: number;
  url?: string | null;
  html_url?: string | null;
  external_url?: string | null;
  content_id?: string | number | null;
  page_url?: string | null;
  published?: boolean;
  locked_for_user?: boolean;
}

interface CanvasModule {
  id?: string | number;
  name?: string;
  position?: number;
  state?: string;
  items?: CanvasModuleItem[];
}

interface CanvasPage {
  url?: string;
  title?: string;
  body?: string | null;
  updated_at?: string | null;
  html_url?: string;
  front_page?: boolean;
  published?: boolean;
}

interface CanvasDiscussionTopic {
  id?: string | number;
  title?: string;
  message?: string | null;
  posted_at?: string | null;
  last_reply_at?: string | null;
  unread_count?: number;
  locked?: boolean;
  html_url?: string;
  is_announcement?: boolean;
  user_id?: string | number | null;
  user_name?: string | null;
  author?: {
    id?: string | number | null;
    display_name?: string | null;
  } | null;
}

function topicAuthor(topic: CanvasAnnouncement | CanvasDiscussionTopic) {
  const rawId = topic.author?.id ?? topic.user_id;
  const rawName = topic.author?.display_name || topic.user_name;
  return {
    authorId: rawId === undefined || rawId === null ? null : String(rawId),
    authorName: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null,
  };
}

interface CanvasFile {
  id?: string | number;
  display_name?: string;
  filename?: string;
  'content-type'?: string;
  size?: number;
  updated_at?: string | null;
  locked?: boolean;
  hidden?: boolean;
  hidden_for_user?: boolean;
  folder_id?: string | number;
  context_id?: string | number;
  context_type?: string;
  url?: string;
  preview_url?: string | null;
}

interface CanvasTabResponse {
  id?: string;
  label?: string;
  type?: string;
  hidden?: boolean;
  visibility?: string;
  position?: number;
  html_url?: string;
}

interface CanvasExternalToolLaunchResponse {
  id?: string | number;
  name?: string;
  url?: string;
}

interface CanvasCalendarEvent {
  id?: string | number;
  title?: string;
  description?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  location_name?: string | null;
  location_address?: string | null;
  context_code?: string;
  html_url?: string;
  assignment?: CanvasAssignment;
}

interface CanvasQuiz {
  id?: string | number;
  title?: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number;
  question_count?: number;
  published?: boolean;
  html_url?: string;
}

interface CanvasTodo {
  type?: string;
  course_id?: string | number;
  assignment?: CanvasAssignment;
  quiz?: CanvasQuiz;
  ignore?: string;
}

function courseName(course: CanvasCourse): string {
  return course.name || course.course_code || 'Unknown course';
}

function submissionStatus(submission: CanvasSubmission = {}): SubmissionStatus {
  if (submission.excused) return 'excused';
  const submittedState = submission.workflow_state === 'submitted' || submission.workflow_state === 'pending_review';
  const submittedEvidence = Boolean(submission.submitted_at) || submittedState;
  // Canvas missing policies can automatically grade work that was never submitted.
  if (submission.missing && !submittedEvidence) return 'missing';
  // A resubmission can retain graded_at from the previous attempt.
  if (submittedState) return submission.late ? 'late' : 'submitted';
  if (submission.workflow_state === 'graded' || submission.graded_at) return 'graded';
  if (submittedEvidence) {
    return submission.late ? 'late' : 'submitted';
  }
  if (submission.late) return 'late';
  return 'unsubmitted';
}

function warningFrom(error: unknown, courseId?: string): LmsWarning {
  const canvasError = asCanvasError(error);
  return {
    code: canvasError.code,
    message: canvasError.message,
    courseId,
    endpoint: canvasError.endpoint,
  };
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const SYLLABUS_TERMS = [
  'syllabus',
  'course outline',
  'course guide',
  'course information',
  'class policies',
  'course schedule',
];

const SYLLABUS_CONTEXT_TERMS = [
  'start here',
  'getting started',
  'welcome',
  'important information',
  'course materials',
  'course documents',
];

function includesAny(value: string, terms: string[]): boolean {
  const normalized = value.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function courseIdFromContext(value: string | undefined): string | null {
  return value?.match(/^course_(.+)$/)?.[1] || null;
}

function fileSummary(file: CanvasFile, courseId: string, course: string, origin: string): CanvasFileSummary {
  const id = String(file.id);
  return {
    id,
    courseId,
    course,
    name: file.display_name || file.filename || 'Untitled file',
    contentType: file['content-type'] || null,
    sizeBytes: typeof file.size === 'number' ? file.size : null,
    updatedAt: file.updated_at || null,
    locked: file.locked === true || file.hidden_for_user === true,
    htmlUrl: `${origin}/courses/${courseId}/files/${id}`,
    downloadUrl: file.url || null,
    folderId: file.folder_id === undefined ? null : String(file.folder_id),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function assignmentSubmissionSummary(
  submission: CanvasSubmission | undefined,
  timeZone: string,
): AssignmentSubmissionSummary | null {
  if (!submission) return null;
  return {
    workflowState: submission.workflow_state || null,
    submittedAt: submission.submitted_at || null,
    submittedAtLocal: toLocal(submission.submitted_at, timeZone),
    gradedAt: submission.graded_at || null,
    gradedAtLocal: toLocal(submission.graded_at, timeZone),
    attempt: numberOrNull(submission.attempt),
    score: numberOrNull(submission.score),
    grade: submission.grade || null,
    excused: submission.excused === true,
    late: submission.late === true,
    missing: submission.missing === true,
  };
}

function assignmentSubmissionDetail(
  submission: CanvasSubmission | undefined,
  timeZone: string,
): AssignmentSubmissionDetail | null {
  const summary = assignmentSubmissionSummary(submission, timeZone);
  if (!submission || !summary) return null;
  return {
    ...summary,
    id: submission.id === undefined ? null : String(submission.id),
    submissionType: submission.submission_type || null,
    body: htmlToText(submission.body || '', 20_000),
    url: submission.url || null,
    previewUrl: submission.preview_url || null,
    enteredScore: numberOrNull(submission.entered_score),
    enteredGrade: submission.entered_grade || null,
    secondsLate: numberOrNull(submission.seconds_late),
    latePolicyStatus: submission.late_policy_status || null,
    attachments: (submission.attachments || [])
      .filter((attachment) => attachment.id !== undefined)
      .map((attachment) => ({
        id: String(attachment.id),
        name: attachment.display_name || attachment.filename || 'Submission attachment',
        contentType: attachment['content-type'] || null,
        sizeBytes: numberOrNull(attachment.size),
        url: attachment.url || null,
        previewUrl: attachment.preview_url || null,
      })),
    comments: (submission.submission_comments || [])
      .filter((comment) => comment.id !== undefined)
      .map((comment) => {
        const rawAuthorId = comment.author?.id ?? comment.author_id;
        const rawAuthorName = comment.author?.display_name || comment.author_name;
        return {
          id: String(comment.id),
          authorId: rawAuthorId === undefined || rawAuthorId === null ? null : String(rawAuthorId),
          authorName: typeof rawAuthorName === 'string' && rawAuthorName.trim() ? rawAuthorName.trim() : null,
          comment: htmlToText(comment.comment || '', 8_000),
          createdAt: comment.created_at || null,
          createdAtLocal: toLocal(comment.created_at, timeZone),
          editedAt: comment.edited_at || null,
          editedAtLocal: toLocal(comment.edited_at, timeZone),
        };
      }),
    rubricAssessment: Object.entries(submission.rubric_assessment || {}).map(([criterionId, assessment]) => ({
      criterionId,
      points: numberOrNull(assessment.points),
      ratingId:
        assessment.rating_id === undefined || assessment.rating_id === null
          ? null
          : String(assessment.rating_id),
      comments: htmlToText(assessment.comments || '', 4_000),
    })),
  };
}

function assignmentDates(
  assignment: CanvasAssignment,
  timeZone: string,
): CanvasAssignmentDate[] {
  return (assignment.all_dates || []).map((date) => ({
    id: date.id === undefined || date.id === null ? null : String(date.id),
    title: date.title || null,
    base: date.base === true,
    dueAt: date.due_at || null,
    dueAtLocal: toLocal(date.due_at, timeZone),
    unlockAt: date.unlock_at || null,
    unlockAtLocal: toLocal(date.unlock_at, timeZone),
    lockAt: date.lock_at || null,
    lockAtLocal: toLocal(date.lock_at, timeZone),
  }));
}

function tabFromCanvas(tab: CanvasTabResponse, courseId: string, origin: string): CanvasTab {
  return {
    id: tab.id || 'unknown',
    label: tab.label || tab.id || 'Untitled tab',
    type: tab.type || null,
    hidden: tab.hidden === true,
    visibility: tab.visibility || null,
    position: typeof tab.position === 'number' ? tab.position : null,
    htmlUrl: tab.html_url ? new URL(tab.html_url, origin).href : `${origin}/courses/${courseId}`,
  };
}

function fileNameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'linked-resource');
  } catch {
    return 'linked-resource';
  }
}

function fileNameForContent(name: string, contentType: string): string {
  if (/\.[a-z0-9]{1,10}$/i.test(name)) return name;
  const extension = new Map([
    ['text/html', '.html'],
    ['text/plain', '.txt'],
    ['text/markdown', '.md'],
    ['application/json', '.json'],
    ['application/xml', '.xml'],
    ['application/pdf', '.pdf'],
    ['application/msword', '.doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ['application/vnd.ms-excel', '.xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ['application/vnd.ms-powerpoint', '.ppt'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ]).get(contentType.toLowerCase());
  return extension ? `${name}${extension}` : name;
}

function searchScore(query: string, title: string, body: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const normalizedTitle = title.toLowerCase();
  const normalizedBody = body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalizedTitle === term) score += 20;
    else if (normalizedTitle.includes(term)) score += 8;
    if (normalizedBody.includes(term)) score += 2;
  }
  if (normalizedTitle.includes(query.toLowerCase())) score += 15;
  if (normalizedBody.includes(query.toLowerCase())) score += 5;
  return score;
}

export class CanvasAdapter implements LmsAdapter {
  private readonly client: CanvasHttpClient;
  private readonly timeZone: string;
  private activeCoursesPromise?: Promise<CanvasCourse[]>;
  private completedCoursesPromise?: Promise<CanvasCourse[]>;

  constructor(connection: CanvasConnection, options: CanvasHttpOptions = {}) {
    this.client = new CanvasHttpClient(connection, options);
    this.timeZone = connection.timeZone || 'America/Chicago';
  }

  async validateSession(): Promise<LmsResult<SessionStatus>> {
    try {
      const { data } = await this.client.getJson<Record<string, unknown>>('/api/v1/users/self/profile');
      if (!data || (typeof data.id !== 'number' && typeof data.id !== 'string') || !String(data.id).trim()) {
        throw new CanvasError('invalid_response', 'Canvas did not return a signed-in student profile.', {
          endpoint: '/api/v1/users/self/profile',
        });
      }
      return {
        data: {
          connected: true,
          canvasHost: this.client.host,
          userId: data?.id === undefined ? undefined : String(data.id),
          userName: typeof data?.name === 'string' ? data.name : undefined,
        },
        warnings: [],
      };
    } catch (error) {
      const canvasError = asCanvasError(error);
      if (canvasError.code === 'session_expired' || canvasError.code === 'permission_denied') {
        return {
          data: {
            connected: false,
            canvasHost: this.client.host,
            errorCode: canvasError.code,
          },
          warnings: [warningFrom(canvasError)],
        };
      }
      throw canvasError;
    }
  }

  async listCourses(): Promise<LmsResult<Course[]>> {
    const raw = await this.fetchCourses();
    return {
      data: raw.map((course) => ({
        id: String(course.id),
        name: courseName(course),
        courseCode: course.course_code || null,
        termName: course.term?.name || null,
        workflowState: course.workflow_state || null,
        startAt: course.start_at || null,
        endAt: course.end_at || null,
        defaultView: course.default_view || null,
        url: `${this.client.origin}/courses/${course.id}`,
      })),
      warnings: [],
    };
  }

  async listCompletedCourses(): Promise<LmsResult<Course[]>> {
    const raw = await this.fetchCompletedCourses();
    return {
      data: raw.map((course) => ({
        id: String(course.id),
        name: courseName(course),
        courseCode: course.course_code || null,
        termName: course.term?.name || null,
        workflowState: course.workflow_state || null,
        startAt: course.start_at || null,
        endAt: course.end_at || null,
        defaultView: course.default_view || null,
        url: `${this.client.origin}/courses/${course.id}`,
      })),
      warnings: [],
    };
  }

  async getExternalToolLaunch(
    courseId: string,
    toolId: string,
  ): Promise<LmsResult<CanvasExternalToolLaunch>> {
    const query = new URLSearchParams({ id: toolId, launch_type: 'course_navigation' });
    const { data } = await this.client.getJson<CanvasExternalToolLaunchResponse>(
      `/api/v1/courses/${encodeURIComponent(courseId)}/external_tools/sessionless_launch?${query}`,
    );
    if (!data?.url) {
      throw new CanvasError('invalid_response', 'Canvas did not return an external-tool launch URL.');
    }
    const url = new URL(data.url, this.client.origin);
    if (url.protocol !== 'https:') {
      throw new CanvasError('invalid_response', 'Canvas returned an unsafe external-tool launch URL.');
    }
    return {
      data: {
        id: data.id === undefined ? null : String(data.id),
        name: data.name || null,
        url: url.href,
      },
      warnings: [],
    };
  }

  async listTabs(courseId: string): Promise<LmsResult<CanvasTab[]>> {
    const { data } = await this.client.getJson<CanvasTabResponse[]>(
      `/api/v1/courses/${encodeURIComponent(courseId)}/tabs?per_page=100`,
      { paginate: true },
    );
    return {
      data: data.map((tab) => tabFromCanvas(tab, courseId, this.client.origin)),
      warnings: [],
    };
  }

  async getCourseOverview(courseId: string): Promise<LmsResult<CourseOverview>> {
    const courseResponse = await this.client.getJson<CanvasCourse>(
      `/api/v1/courses/${encodeURIComponent(courseId)}?include[]=syllabus_body&include[]=teachers&include[]=term`,
    );
    let tabsResponse: LmsResult<CanvasTab[]> = { data: [], warnings: [] };
    try {
      tabsResponse = await this.listTabs(courseId);
    } catch (error) {
      tabsResponse.warnings.push(warningFrom(error, courseId));
    }
    const course = courseResponse.data;
    if (!course?.id) throw new CanvasError('not_found', `Course ${courseId} was not found.`);
    const syllabusHtml = course.syllabus_body || '';
    return {
      data: {
        id: String(course.id),
        name: courseName(course),
        courseCode: course.course_code || null,
        workflowState: course.workflow_state || null,
        startAt: course.start_at || null,
        endAt: course.end_at || null,
        defaultView: course.default_view || null,
        url: `${this.client.origin}/courses/${course.id}`,
        termName: course.term?.name || null,
        teachers: (course.teachers || [])
          .filter((teacher) => teacher.id !== undefined)
          .map((teacher) => ({
            id: String(teacher.id),
            name: teacher.name || teacher.display_name || 'Instructor',
            displayName: teacher.display_name || null,
          })),
        tabs: tabsResponse.data,
        syllabusText: htmlToText(syllabusHtml, 20_000),
        links: extractResourceLinks(syllabusHtml, this.client.origin),
      },
      warnings: tabsResponse.warnings,
    };
  }

  async listAssignments(args: AssignmentQuery = {}): Promise<LmsResult<Assignment[]>> {
    const parseBound = (value: string | undefined) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
        throw new CanvasError('invalid_response', 'Assignment date bounds must be valid dates.');
      }
      return Date.parse(value);
    };
    const dueAfterMs = parseBound(args.dueAfter);
    const dueBeforeMs = parseBound(args.dueBefore);
    if (dueAfterMs !== undefined && dueBeforeMs !== undefined && dueBeforeMs < dueAfterMs) {
      throw new CanvasError('invalid_response', 'Assignment date bounds must be ordered.');
    }
    const courses = (await this.fetchCourses()).filter(
      (course) => !args.courseId || String(course.id) === args.courseId,
    );
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasAssignment[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/assignments?include[]=submission&order_by=due_at&per_page=100`,
          { paginate: true },
        );
        return data
          .filter((assignment) => assignment?.id !== undefined)
          .map((assignment): Assignment => ({
            id: String(assignment.id),
            courseId: id,
            course: courseName(course),
            name: assignment.name || 'Untitled',
             dueAt: assignment.due_at || null,
             dueAtLocal: toLocal(assignment.due_at, this.timeZone),
             unlockAt: assignment.unlock_at || null,
             unlockAtLocal: toLocal(assignment.unlock_at, this.timeZone),
             lockAt: assignment.lock_at || null,
             lockAtLocal: toLocal(assignment.lock_at, this.timeZone),
             pointsPossible:
               typeof assignment.points_possible === 'number' ? assignment.points_possible : null,
             submissionStatus: submissionStatus(assignment.submission),
             submission: assignmentSubmissionSummary(assignment.submission, this.timeZone),
             url: assignment.html_url || `${this.client.origin}/courses/${id}/assignments/${assignment.id}`,
           }));
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });

    const assignments = perCourse.flat().filter((assignment) => {
      if (!assignment.dueAt) return args.includeUndated ?? true;
      const dueMs = Date.parse(assignment.dueAt);
      if (!Number.isFinite(dueMs)) return args.includeUndated ?? true;
      if (dueAfterMs !== undefined && dueMs < dueAfterMs) return false;
      if (dueBeforeMs !== undefined && dueMs > dueBeforeMs) return false;
      return true;
    });
    assignments.sort((left, right) => {
      const leftMs = left.dueAt ? Date.parse(left.dueAt) : Infinity;
      const rightMs = right.dueAt ? Date.parse(right.dueAt) : Infinity;
      return (Number.isFinite(leftMs) ? leftMs : Infinity) - (Number.isFinite(rightMs) ? rightMs : Infinity);
    });
    return { data: assignments, warnings };
  }

  async listGrades(): Promise<LmsResult<CourseGrade[]>> {
    const courses = await this.fetchCourses();
    return {
      data: courses.map((course) => {
        const enrollment =
          course.enrollments?.find(
            (item) =>
              item.computed_current_score != null ||
              item.type === 'student' ||
              item.role === 'StudentEnrollment',
          ) ?? course.enrollments?.[0];
        return {
          courseId: String(course.id),
          courseName: courseName(course),
          currentScore:
            typeof enrollment?.computed_current_score === 'number'
              ? enrollment.computed_current_score
              : null,
          currentGrade:
            enrollment?.computed_current_grade || enrollment?.computed_current_letter_grade || null,
          url: `${this.client.origin}/courses/${course.id}/grades`,
        };
      }),
      warnings: [],
    };
  }

  async listAnnouncements(args: AnnouncementQuery = {}): Promise<LmsResult<Announcement[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !args.courseId || String(course.id) === args.courseId,
    );
    const warnings: LmsWarning[] = [];
    const limit = Math.max(1, Math.min(args.perCourseLimit ?? 50, 100));
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasAnnouncement[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/discussion_topics?only_announcements=true&per_page=${limit}`,
          { paginate: true },
        );
        return data
          .filter((announcement) => announcement?.id !== undefined)
          .map((announcement): Announcement => {
            const postedAt = announcement.posted_at || announcement.created_at || '';
            const author = topicAuthor(announcement);
            return {
              id: String(announcement.id),
              courseId: id,
              course: courseName(course),
              title: announcement.title || 'Untitled',
              postedAt,
              postedAtLocal: toLocal(postedAt, this.timeZone, 'long'),
              ...author,
              message: htmlToText(announcement.message || '', 2_000),
              url: announcement.html_url || `${this.client.origin}/courses/${id}/discussion_topics/${announcement.id}`,
            };
          });
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });
    const announcements = perCourse.flat();
    announcements.sort((left, right) => (Date.parse(right.postedAt) || 0) - (Date.parse(left.postedAt) || 0));
    return { data: announcements, warnings };
  }

  async listModules(courseId?: string): Promise<LmsResult<CourseModule[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasModule[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/modules?include[]=items&include[]=content_details&per_page=100`,
          { paginate: true },
        );
        return data
          .filter((module) => module?.id !== undefined)
          .map((module): CourseModule => ({
            id: String(module.id),
            courseId: id,
            course: courseName(course),
            name: module.name || 'Untitled module',
            position: typeof module.position === 'number' ? module.position : null,
            state: module.state || null,
            items: (module.items || [])
              .filter((item) => item?.id !== undefined)
              .map((item): ModuleItem => ({
                id: String(item.id),
                title: item.title || 'Untitled item',
                type: item.type || 'Unknown',
                position: typeof item.position === 'number' ? item.position : null,
                url: item.url || null,
                htmlUrl: item.html_url || null,
                externalUrl: item.external_url || null,
                contentId: item.content_id === undefined || item.content_id === null ? null : String(item.content_id),
                pageUrl: item.page_url || null,
                published: typeof item.published === 'boolean' ? item.published : null,
                locked: item.locked_for_user === true,
              })),
          }));
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });
    return { data: perCourse.flat(), warnings };
  }

  async getSyllabus(courseId?: string): Promise<LmsResult<CourseSyllabus[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    const warnings: LmsWarning[] = [];
    const syllabi = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasCourse>(
          `/api/v1/courses/${encodeURIComponent(id)}?include[]=syllabus_body`,
        );
        const html = data?.syllabus_body || '';
        if (!html) return null;
        return {
          courseId: id,
          courseName: courseName(course),
          syllabusBody: htmlToText(html),
          linkedFiles: extractCanvasFileLinks(html, this.client.origin),
          url: `${this.client.origin}/courses/${id}/assignments/syllabus`,
        } satisfies CourseSyllabus;
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return null;
      }
    });
    return { data: syllabi.filter((value): value is CourseSyllabus => value !== null), warnings };
  }

  async findSyllabus(courseId: string): Promise<LmsResult<CanvasSyllabusDiscovery>> {
    const [overview, pagesResult, modulesResult, filesResult] = await Promise.all([
      this.getCourseOverview(courseId),
      this.listPages(courseId),
      this.listModules(courseId),
      this.listFiles(courseId),
    ]);
    const warnings = [
      ...overview.warnings,
      ...pagesResult.warnings,
      ...modulesResult.warnings,
      ...filesResult.warnings,
    ];
    const candidates: CanvasSyllabusCandidate[] = [];
    const addCandidate = (candidate: CanvasSyllabusCandidate) => {
      if (!candidates.some((item) => item.kind === candidate.kind && item.url === candidate.url)) {
        candidates.push(candidate);
      }
    };

    if (overview.data.syllabusText || overview.data.links.length > 0) {
      addCandidate({
        kind: 'canvas_syllabus',
        confidence: 100,
        title: `${overview.data.name} syllabus`,
        reason: 'Canvas exposes a course syllabus body.',
        url: `${this.client.origin}/courses/${courseId}/assignments/syllabus`,
        text: overview.data.syllabusText,
        fileId: null,
        pageUrl: null,
        links: overview.data.links,
      });
    }

    for (const tab of overview.data.tabs) {
      if (!tab.hidden && includesAny(`${tab.id} ${tab.label}`, SYLLABUS_TERMS)) {
        addCandidate({
          kind: 'course_tab',
          confidence: 95,
          title: tab.label,
          reason: 'The course navigation contains a syllabus-like tab.',
          url: tab.htmlUrl,
          text: '',
          fileId: null,
          pageUrl: null,
          links: [],
        });
      }
    }

    const modulePageUrls = new Set(
      modulesResult.data.flatMap((module) =>
        module.items
          .filter((item) => item.pageUrl && (
            includesAny(item.title, SYLLABUS_TERMS) ||
            includesAny(module.name, SYLLABUS_CONTEXT_TERMS)
          ))
          .map((item) => item.pageUrl!),
      ),
    );
    const pagesToRead = pagesResult.data
      .filter((page) => page.frontPage || includesAny(page.title, SYLLABUS_TERMS) || modulePageUrls.has(page.pageUrl))
      .slice(0, 8);
    const pageDetails = await mapConcurrent(pagesToRead, 4, async (page) => {
      try {
        const { data } = await this.client.getJson<CanvasPage>(
          `/api/v1/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(page.pageUrl)}`,
        );
        return { summary: page, raw: data };
      } catch (error) {
        warnings.push(warningFrom(error, courseId));
        return null;
      }
    });

    for (const detail of pageDetails) {
      if (!detail) continue;
      const html = detail.raw.body || '';
      const text = htmlToText(html, 20_000);
      const links = extractResourceLinks(html, this.client.origin);
      const looksLikeSyllabus = includesAny(`${detail.summary.title} ${text.slice(0, 4_000)}`, SYLLABUS_TERMS);
      const confidence = includesAny(detail.summary.title, SYLLABUS_TERMS)
        ? 92
        : looksLikeSyllabus
          ? 82
          : detail.summary.frontPage
            ? 60
            : 45;
      addCandidate({
        kind: 'page',
        confidence,
        title: detail.summary.title,
        reason: detail.summary.frontPage
          ? 'This is the course home page and may point to an externally hosted syllabus.'
          : 'The page title or content looks like a syllabus.',
        url: detail.summary.htmlUrl,
        text,
        fileId: null,
        pageUrl: detail.summary.pageUrl,
        links,
      });
      for (const link of links) {
        const fileId = canvasFileIdFromUrl(link.apiUrl || link.url);
        if (fileId) continue;
        if (link.external && (
          detail.summary.frontPage ||
          looksLikeSyllabus ||
          includesAny(`${link.label} ${link.url}`, SYLLABUS_TERMS)
        )) {
          const explicitlySyllabusLike = includesAny(`${link.label} ${link.url}`, SYLLABUS_TERMS);
          addCandidate({
            kind: 'external_link',
            confidence: explicitlySyllabusLike ? 78 : detail.summary.frontPage ? 58 : 55,
            title: link.label,
            reason: `Linked from ${detail.summary.frontPage ? 'the course home page' : detail.summary.title}.`,
            url: link.url,
            text: '',
            fileId: null,
            pageUrl: detail.summary.pageUrl,
            links: [],
          });
        }
      }
    }

    for (const module of modulesResult.data) {
      for (const item of module.items) {
        const explicitlySyllabusLike = includesAny(`${module.name} ${item.title}`, SYLLABUS_TERMS);
        const contextualResource = includesAny(module.name, SYLLABUS_CONTEXT_TERMS) &&
          ['file', 'externalurl'].includes(item.type.toLowerCase());
        if (!explicitlySyllabusLike && !contextualResource) continue;
        const resourceUrl = item.externalUrl || item.htmlUrl || item.url || `${this.client.origin}/courses/${courseId}/modules`;
        addCandidate({
          kind: 'module_item',
          confidence: explicitlySyllabusLike ? 86 : 58,
          title: item.title,
          reason: explicitlySyllabusLike
            ? `A syllabus-like item appears in the ${module.name} module.`
            : `A course resource appears in the ${module.name} module.`,
          url: resourceUrl,
          text: '',
          fileId: item.type.toLowerCase() === 'file' ? item.contentId : canvasFileIdFromUrl(resourceUrl),
          pageUrl: item.pageUrl,
          links: [],
        });
      }
    }

    for (const file of filesResult.data) {
      if (!includesAny(file.name, SYLLABUS_TERMS)) continue;
      addCandidate({
        kind: 'file',
        confidence: 90,
        title: file.name,
        reason: 'The course file name strongly suggests a syllabus or course outline.',
        url: file.htmlUrl,
        text: '',
        fileId: file.id,
        pageUrl: null,
        links: [],
      });
    }

    for (const link of overview.data.links) {
      const fileId = canvasFileIdFromUrl(link.apiUrl || link.url);
      if (fileId) {
        addCandidate({
          kind: 'file',
          confidence: 96,
          title: link.label,
          reason: 'The Canvas syllabus body links directly to this file.',
          url: link.url,
          text: '',
          fileId,
          pageUrl: null,
          links: [],
        });
      } else if (link.external) {
        addCandidate({
          kind: 'external_link',
          confidence: 80,
          title: link.label,
          reason: 'The Canvas syllabus body links to this external resource.',
          url: link.url,
          text: '',
          fileId: null,
          pageUrl: null,
          links: [],
        });
      }
    }

    candidates.sort((left, right) => right.confidence - left.confidence || left.title.localeCompare(right.title));
    return {
      data: {
        courseId,
        courseName: overview.data.name,
        found: candidates.some((candidate) => candidate.confidence >= 75),
        searched: ['Canvas syllabus body', 'course navigation tabs', 'course home page', 'pages', 'modules', 'files', 'external links'],
        candidates: candidates.slice(0, 16),
      },
      warnings,
    };
  }

  async getAssignmentDetail(
    courseId: string,
    assignmentId: string,
  ): Promise<LmsResult<AssignmentDetail>> {
    const [assignmentResponse, courseResponse, submissionResponse] = await Promise.all([
      this.client.getJson<CanvasAssignment>(
        `/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}?include[]=submission&all_dates=true`,
      ),
      this.client.getJson<CanvasCourse>(`/api/v1/courses/${encodeURIComponent(courseId)}`),
      this.client.getJson<CanvasSubmission>(
        `/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self?include[]=submission_comments&include[]=rubric_assessment&include[]=read_status&include[]=student_entered_score`,
      ).then(
        (response) => ({ response } as const),
        (error: unknown) => ({ error } as const),
      ),
    ]);
    const assignment = assignmentResponse.data;
    if (!assignment?.id) {
      throw new CanvasError('not_found', `Assignment ${assignmentId} was not found.`);
    }
    const dueAt = assignment.due_at || null;
    const unlockAt = assignment.unlock_at || null;
    const lockAt = assignment.lock_at || null;
    const submission = 'response' in submissionResponse
      ? submissionResponse.response.data
      : assignment.submission;
    const warnings = 'error' in submissionResponse
      ? [warningFrom(submissionResponse.error, courseId)]
      : [];
    let externalTool: AssignmentDetail['externalTool'] = null;
    if (assignment.external_tool_tag_attributes?.url) {
      try {
        const url = new URL(assignment.external_tool_tag_attributes.url, this.client.origin);
        if (url.protocol === 'https:') {
          externalTool = {
            url: url.href,
            newTab: assignment.external_tool_tag_attributes.new_tab === true,
            resourceLinkId: assignment.external_tool_tag_attributes.resource_link_id || null,
          };
        }
      } catch {
        // Ignore malformed external-tool metadata while preserving the assignment itself.
      }
    }
    return {
      data: {
        id: String(assignment.id),
        courseId,
        course: courseName(courseResponse.data || {}),
        name: assignment.name || 'Untitled',
        dueAt,
        dueAtLocal: toLocal(dueAt, this.timeZone),
        unlockAt,
        unlockAtLocal: toLocal(unlockAt, this.timeZone),
        lockAt,
        lockAtLocal: toLocal(lockAt, this.timeZone),
        pointsPossible:
          typeof assignment.points_possible === 'number' ? assignment.points_possible : null,
        submissionStatus: submissionStatus(submission),
        submission: assignmentSubmissionDetail(submission, this.timeZone),
        url:
          assignment.html_url ||
          `${this.client.origin}/courses/${courseId}/assignments/${assignmentId}`,
        assignmentGroupId:
          assignment.assignment_group_id === undefined || assignment.assignment_group_id === null
            ? null
            : String(assignment.assignment_group_id),
        position: numberOrNull(assignment.position),
        published: typeof assignment.published === 'boolean' ? assignment.published : null,
        omitFromFinalGrade: assignment.omit_from_final_grade === true,
        allowedAttempts: numberOrNull(assignment.allowed_attempts),
        hasSubmittedSubmissions: assignment.has_submitted_submissions === true,
        locked: assignment.locked_for_user === true,
        lockExplanation: assignment.lock_explanation || null,
        description: htmlToText(assignment.description || '', 10_000),
        submissionTypes: Array.isArray(assignment.submission_types)
          ? assignment.submission_types.filter((value): value is string => typeof value === 'string')
          : [],
        allowedExtensions: Array.isArray(assignment.allowed_extensions)
          ? assignment.allowed_extensions.filter((value): value is string => typeof value === 'string')
          : [],
        gradingType: assignment.grading_type || null,
        dates: assignmentDates(assignment, this.timeZone),
        groupAssignment: {
          groupCategoryId:
            assignment.group_category_id === undefined || assignment.group_category_id === null
              ? null
              : String(assignment.group_category_id),
          gradeGroupStudentsIndividually: assignment.grade_group_students_individually === true,
        },
        peerReview: {
          enabled: assignment.peer_reviews === true,
          automatic: assignment.automatic_peer_reviews === true,
          anonymous: assignment.anonymous_peer_reviews === true,
        },
        externalTool,
        rubric: (assignment.rubric || []).map((criterion, index) => ({
          id: criterion.id === undefined ? `criterion-${index + 1}` : String(criterion.id),
          description: criterion.description || '',
          longDescription: htmlToText(criterion.long_description || '', 4_000),
          points: typeof criterion.points === 'number' ? criterion.points : null,
          ratings: (criterion.ratings || []).map((rating, ratingIndex) => ({
            id: rating.id === undefined ? `rating-${ratingIndex + 1}` : String(rating.id),
            description: rating.description || '',
            longDescription: htmlToText(rating.long_description || '', 2_000),
            points: numberOrNull(rating.points),
          })),
        })),
        rubricSettings: assignment.rubric_settings
          ? {
              title: assignment.rubric_settings.title || null,
              pointsPossible: numberOrNull(assignment.rubric_settings.points_possible),
              freeFormCriterionComments: assignment.rubric_settings.free_form_criterion_comments === true,
              hideScoreTotal: assignment.rubric_settings.hide_score_total_outcome === true,
            }
          : null,
        links: extractResourceLinks(assignment.description || '', this.client.origin),
      },
      warnings,
    };
  }

  async listPages(courseId?: string): Promise<LmsResult<CanvasPageSummary[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasPage[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/pages?sort=title&order=asc&per_page=100`,
          { paginate: true },
        );
        return data
          .filter((page) => typeof page?.url === 'string')
          .map((page): CanvasPageSummary => ({
            courseId: id,
            course: courseName(course),
            pageUrl: page.url!,
            title: page.title || 'Untitled page',
            frontPage: page.front_page === true,
            published: typeof page.published === 'boolean' ? page.published : null,
            updatedAt: page.updated_at || null,
            htmlUrl: page.html_url || `${this.client.origin}/courses/${id}/pages/${page.url}`,
          }));
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });
    return { data: perCourse.flat(), warnings };
  }

  async getPage(courseId: string, pageUrl: string): Promise<LmsResult<CanvasPageDetail>> {
    const [pageResponse, courseResponse] = await Promise.all([
      this.client.getJson<CanvasPage>(
        `/api/v1/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(pageUrl)}`,
      ),
      this.client.getJson<CanvasCourse>(`/api/v1/courses/${encodeURIComponent(courseId)}`),
    ]);
    const page = pageResponse.data;
    if (!page?.url) throw new CanvasError('not_found', `Page ${pageUrl} was not found.`);
    const html = page.body || '';
    return {
      data: {
        courseId,
        course: courseName(courseResponse.data || {}),
        pageUrl: page.url,
        title: page.title || 'Untitled page',
        frontPage: page.front_page === true,
        published: typeof page.published === 'boolean' ? page.published : null,
        updatedAt: page.updated_at || null,
        htmlUrl: page.html_url || `${this.client.origin}/courses/${courseId}/pages/${page.url}`,
        body: htmlToText(html, 20_000),
        linkedFiles: extractCanvasFileLinks(html, this.client.origin),
        links: extractResourceLinks(html, this.client.origin),
      },
      warnings: [],
    };
  }

  async listDiscussions(courseId?: string): Promise<LmsResult<CanvasDiscussion[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasDiscussionTopic[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/discussion_topics?per_page=100`,
          { paginate: true },
        );
        return data
          .filter((topic) => topic?.id !== undefined && topic.is_announcement !== true)
          .map((topic): CanvasDiscussion => ({
            id: String(topic.id),
            courseId: id,
            course: courseName(course),
            title: topic.title || 'Untitled discussion',
            message: htmlToText(topic.message || '', 4_000),
            postedAt: topic.posted_at || null,
            lastReplyAt: topic.last_reply_at || null,
            unreadCount: typeof topic.unread_count === 'number' ? topic.unread_count : null,
            locked: topic.locked === true,
            url:
              topic.html_url || `${this.client.origin}/courses/${id}/discussion_topics/${topic.id}`,
          }));
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });
    return { data: perCourse.flat(), warnings };
  }

  async listFiles(courseId?: string): Promise<LmsResult<CanvasFileSummary[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasFile[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/files?sort=updated_at&order=desc&per_page=100`,
          { paginate: true },
        );
        return data
          .filter((file) => file?.id !== undefined)
          .map((file): CanvasFileSummary => fileSummary(file, id, courseName(course), this.client.origin));
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });
    return { data: perCourse.flat(), warnings };
  }

  async downloadFile(
    courseId: string,
    fileId: string,
    maxBytes = 15 * 1024 * 1024,
  ): Promise<LmsResult<CanvasFileDownload>> {
    const [fileResponse, courseResponse] = await Promise.all([
      this.client.getJson<CanvasFile>(`/api/v1/files/${encodeURIComponent(fileId)}`),
      this.client.getJson<CanvasCourse>(`/api/v1/courses/${encodeURIComponent(courseId)}`),
    ]);
    const file = fileResponse.data;
    if (!file?.id || !file.url) throw new CanvasError('not_found', `File ${fileId} was not found.`);
    if (
      file.context_type?.toLowerCase() === 'course' &&
      file.context_id !== undefined &&
      String(file.context_id) !== courseId
    ) {
      throw new CanvasError('permission_denied', 'That file does not belong to the requested course.');
    }
    if (file.locked || file.hidden_for_user) {
      throw new CanvasError('permission_denied', 'That Canvas file is locked for this student.');
    }
    if (typeof file.size === 'number' && file.size > maxBytes) {
      throw new CanvasError('invalid_response', `The file is larger than ${maxBytes} bytes.`, { status: 413 });
    }
    const downloaded = await this.client.getBinary(file.url, { maxBytes });
    if (downloaded.contentType === 'text/html' && file['content-type'] && file['content-type'] !== 'text/html') {
      throw new CanvasError('invalid_response', 'Canvas returned an HTML page instead of the requested course document.');
    }
    const normalized = fileSummary(file, courseId, courseName(courseResponse.data || {}), this.client.origin);
    return {
      data: {
        file: {
          ...normalized,
          name: downloaded.fileName || normalized.name,
          contentType: downloaded.contentType || normalized.contentType,
          sizeBytes: downloaded.bytes.byteLength,
          downloadUrl: downloaded.finalUrl,
        },
        bytes: downloaded.bytes,
      },
      warnings: [],
    };
  }

  async downloadExternalResource(
    url: string,
    maxBytes = 15 * 1024 * 1024,
  ): Promise<LmsResult<CanvasFileDownload>> {
    const downloaded = await this.client.getBinary(url, { maxBytes, allowExternalInitial: true });
    const fileName = fileNameForContent(
      downloaded.fileName || fileNameFromUrl(downloaded.finalUrl),
      downloaded.contentType,
    );
    return {
      data: {
        file: {
          id: 'external',
          courseId: 'external',
          course: 'External resource',
          name: fileName,
          contentType: downloaded.contentType,
          sizeBytes: downloaded.bytes.byteLength,
          updatedAt: null,
          locked: false,
          htmlUrl: url,
          downloadUrl: downloaded.finalUrl,
          folderId: null,
        },
        bytes: downloaded.bytes,
      },
      warnings: [],
    };
  }

  async listQuizzes(courseId?: string): Promise<LmsResult<CanvasQuizSummary[]>> {
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 5, async (course) => {
      const id = String(course.id);
      try {
        const { data } = await this.client.getJson<CanvasQuiz[]>(
          `/api/v1/courses/${encodeURIComponent(id)}/quizzes?per_page=100`,
          { paginate: true },
        );
        return data
          .filter((quiz) => quiz?.id !== undefined)
          .map((quiz): CanvasQuizSummary => ({
            id: String(quiz.id),
            courseId: id,
            course: courseName(course),
            title: quiz.title || 'Untitled quiz',
            description: htmlToText(quiz.description || '', 4_000),
            dueAt: quiz.due_at || null,
            dueAtLocal: toLocal(quiz.due_at, this.timeZone),
            pointsPossible: typeof quiz.points_possible === 'number' ? quiz.points_possible : null,
            questionCount: typeof quiz.question_count === 'number' ? quiz.question_count : null,
            published: typeof quiz.published === 'boolean' ? quiz.published : null,
            htmlUrl: quiz.html_url || `${this.client.origin}/courses/${id}/quizzes/${quiz.id}`,
          }));
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'session_expired') throw error;
        warnings.push(warningFrom(error, id));
        return [];
      }
    });
    return { data: perCourse.flat(), warnings };
  }

  async getSchedule(args: CanvasScheduleQuery): Promise<LmsResult<CanvasScheduleItem[]>> {
    if (!args.startDate || !args.endDate || args.startDate.length > 40 || args.endDate.length > 40) {
      throw new CanvasError('invalid_response', 'A bounded Canvas schedule date range is required.');
    }
    const startMs = Date.parse(args.startDate);
    const endMs = Date.parse(args.endDate);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > 370 * 24 * 60 * 60 * 1_000) {
      throw new CanvasError('invalid_response', 'Canvas schedule ranges must be valid, ordered, and no longer than 370 days.');
    }
    const context = args.courseId ? `&context_codes[]=${encodeURIComponent(`course_${args.courseId}`)}` : '';
    const base = `/api/v1/calendar_events?start_date=${encodeURIComponent(args.startDate)}&end_date=${encodeURIComponent(args.endDate)}${context}&per_page=100`;
    const eventTypes = args.includeAssignments === false ? ['event'] : ['event', 'assignment'];
    const responses = await Promise.all(
      eventTypes.map((type) => this.client.getJson<CanvasCalendarEvent[]>(`${base}&type=${type}`, { paginate: true })),
    );
    const courses = await this.fetchCourses();
    const courseNames = new Map(courses.map((course) => [String(course.id), courseName(course)]));
    const data = responses.flatMap((response, responseIndex) =>
      response.data
        .filter((event) => event.id !== undefined)
        .map((event): CanvasScheduleItem => {
          const assignment = event.assignment;
          const type = eventTypes[responseIndex] as 'event' | 'assignment';
          const courseId = courseIdFromContext(event.context_code);
          const startAt = event.start_at || assignment?.due_at || null;
          const location = [event.location_name, event.location_address].filter(Boolean).join(' — ') || null;
          return {
            id: String(event.id),
            type,
            courseId,
            course: courseId ? courseNames.get(courseId) || null : null,
            title: assignment?.name || event.title || 'Canvas calendar item',
            description: htmlToText(assignment?.description || event.description || '', 4_000),
            startAt,
            startAtLocal: toLocal(startAt, this.timeZone),
            endAt: event.end_at || null,
            endAtLocal: toLocal(event.end_at, this.timeZone),
            location,
            url: assignment?.html_url || event.html_url || null,
          };
        }),
    );
    data.sort((left, right) => (left.startAt ? Date.parse(left.startAt) : Infinity) - (right.startAt ? Date.parse(right.startAt) : Infinity));
    return { data, warnings: [] };
  }

  async searchCourse(
    rawQuery: string,
    courseId?: string,
    limit = 30,
  ): Promise<LmsResult<CanvasCourseSearch>> {
    const query = rawQuery.trim();
    if (!query || query.length > 200) {
      throw new CanvasError('invalid_response', 'Canvas search requires a query of at most 200 characters.');
    }
    const courses = (await this.fetchCourses()).filter(
      (course) => !courseId || String(course.id) === courseId,
    );
    if (courseId && courses.length === 0) {
      throw new CanvasError('not_found', `Course ${courseId} was not found.`);
    }
    const warnings: LmsWarning[] = [];
    const perCourse = await mapConcurrent(courses, 3, async (course) => {
      const id = String(course.id);
      const name = courseName(course);
      const endpoints = [
        `/api/v1/courses/${encodeURIComponent(id)}/assignments?include[]=submission&per_page=100`,
        `/api/v1/courses/${encodeURIComponent(id)}/modules?include[]=items&include[]=content_details&per_page=100`,
        `/api/v1/courses/${encodeURIComponent(id)}/pages?sort=title&order=asc&per_page=100`,
        `/api/v1/courses/${encodeURIComponent(id)}/discussion_topics?per_page=100`,
        `/api/v1/courses/${encodeURIComponent(id)}/files?sort=updated_at&order=desc&per_page=100`,
        `/api/v1/courses/${encodeURIComponent(id)}/quizzes?per_page=100`,
        `/api/v1/courses/${encodeURIComponent(id)}/tabs?per_page=100`,
      ] as const;
      const settled = await Promise.allSettled([
        this.client.getJson<CanvasAssignment[]>(endpoints[0], { paginate: true }),
        this.client.getJson<CanvasModule[]>(endpoints[1], { paginate: true }),
        this.client.getJson<CanvasPage[]>(endpoints[2], { paginate: true }),
        this.client.getJson<CanvasDiscussionTopic[]>(endpoints[3], { paginate: true }),
        this.client.getJson<CanvasFile[]>(endpoints[4], { paginate: true }),
        this.client.getJson<CanvasQuiz[]>(endpoints[5], { paginate: true }),
        this.client.getJson<CanvasTabResponse[]>(endpoints[6], { paginate: true }),
      ]);
      settled.forEach((result, index) => {
        if (result.status === 'rejected') warnings.push({ ...warningFrom(result.reason, id), endpoint: endpoints[index] });
      });
      const assignments = settled[0].status === 'fulfilled' ? settled[0].value.data : [];
      const modules = settled[1].status === 'fulfilled' ? settled[1].value.data : [];
      const pages = settled[2].status === 'fulfilled' ? settled[2].value.data : [];
      const discussions = settled[3].status === 'fulfilled' ? settled[3].value.data : [];
      const files = settled[4].status === 'fulfilled' ? settled[4].value.data : [];
      const quizzes = settled[5].status === 'fulfilled' ? settled[5].value.data : [];
      const tabs = settled[6].status === 'fulfilled' ? settled[6].value.data : [];
      const results: CanvasSearchResult[] = [];
      const add = (
        kind: CanvasSearchResult['kind'],
        itemId: string,
        title: string,
        body: string,
        url: string | null,
        fileId: string | null = null,
        pageUrl: string | null = null,
        author: { authorId: string | null; authorName: string | null } | null = null,
      ) => {
        const score = searchScore(query, title, body);
        if (score <= 0) return;
        results.push({
          kind,
          id: itemId,
          courseId: id,
          course: name,
          title,
          excerpt: htmlToText(body, 2_000),
          url,
          score,
          fileId,
          pageUrl,
          ...(author || {}),
        });
      };

      for (const assignment of assignments) {
        if (assignment.id === undefined) continue;
        add('assignment', String(assignment.id), assignment.name || 'Untitled assignment', assignment.description || '', assignment.html_url || null);
      }
      for (const module of modules) {
        if (module.id !== undefined) add('module', String(module.id), module.name || 'Untitled module', '', `${this.client.origin}/courses/${id}/modules`);
        for (const item of module.items || []) {
          if (item.id === undefined) continue;
          add(
            'module',
            String(item.id),
            item.title || 'Untitled module item',
            module.name || '',
            item.external_url || item.html_url || item.url || null,
            item.type?.toLowerCase() === 'file' && item.content_id != null ? String(item.content_id) : null,
            item.page_url || null,
          );
        }
      }

      const pagesToRead = pages
        .filter((page) => page.url)
        .sort((left, right) => searchScore(query, right.title || '', '') - searchScore(query, left.title || '', ''))
        .slice(0, 25);
      const pageDetails = await mapConcurrent(pagesToRead, 5, async (page) => {
        try {
          return (
            await this.client.getJson<CanvasPage>(
              `/api/v1/courses/${encodeURIComponent(id)}/pages/${encodeURIComponent(page.url!)}`,
            )
          ).data;
        } catch (error) {
          warnings.push(warningFrom(error, id));
          return page;
        }
      });
      for (const page of pageDetails) {
        if (!page.url) continue;
        add(
          'page',
          page.url,
          page.title || 'Untitled page',
          page.body || '',
          page.html_url || `${this.client.origin}/courses/${id}/pages/${page.url}`,
          null,
          page.url,
        );
      }
      for (const topic of discussions) {
        if (topic.id === undefined) continue;
        add(
          topic.is_announcement ? 'announcement' : 'discussion',
          String(topic.id),
          topic.title || 'Untitled discussion',
          topic.message || '',
          topic.html_url || null,
          null,
          null,
          topicAuthor(topic),
        );
      }
      for (const file of files) {
        if (file.id === undefined) continue;
        const normalized = fileSummary(file, id, name, this.client.origin);
        add('file', normalized.id, normalized.name, normalized.contentType || '', normalized.htmlUrl, normalized.id);
      }
      for (const quiz of quizzes) {
        if (quiz.id === undefined) continue;
        add('quiz', String(quiz.id), quiz.title || 'Untitled quiz', quiz.description || '', quiz.html_url || null);
      }
      for (const tab of tabs) {
        if (!tab.id || tab.hidden) continue;
        const normalized = tabFromCanvas(tab, id, this.client.origin);
        add('tab', normalized.id, normalized.label, normalized.type || '', normalized.htmlUrl);
      }
      return results;
    });

    const results = perCourse.flat().sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
    return {
      data: {
        query,
        courseIds: courses.map((course) => String(course.id)),
        results: results.slice(0, Math.max(1, Math.min(Math.trunc(limit), 100))),
      },
      warnings,
    };
  }

  async listTodos(): Promise<LmsResult<CanvasTodoItem[]>> {
    const { data } = await this.client.getJson<CanvasTodo[]>(
      '/api/v1/users/self/todo?per_page=100',
      { paginate: true },
    );
    return {
      data: data.map((todo): CanvasTodoItem => {
        const item = todo.assignment || todo.quiz;
        const dueAt = item?.due_at || null;
        const itemId = item?.id === undefined ? null : String(item.id);
        const courseId = todo.course_id === undefined ? null : String(todo.course_id);
        return {
          type: todo.type || 'todo',
          courseId,
          assignmentId: itemId,
          title:
            ('name' in (item || {}) ? (item as CanvasAssignment).name : (item as CanvasQuiz | undefined)?.title) ||
            'Canvas to-do',
          dueAt,
          dueAtLocal: toLocal(dueAt, this.timeZone),
          htmlUrl:
            item && 'html_url' in item && typeof item.html_url === 'string' ? item.html_url : null,
        };
      }),
      warnings: [],
    };
  }

  private async fetchCourses(): Promise<CanvasCourse[]> {
    if (!this.activeCoursesPromise) {
      this.activeCoursesPromise = this.client
        .getJson<CanvasCourse[]>(
          '/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term&per_page=100',
          { paginate: true },
        )
        .then(({ data }) => data.filter((course) => course?.id !== undefined))
        .finally(() => {
          this.activeCoursesPromise = undefined;
        });
    }
    return this.activeCoursesPromise;
  }

  private async fetchCompletedCourses(): Promise<CanvasCourse[]> {
    if (!this.completedCoursesPromise) {
      this.completedCoursesPromise = this.client
        .getJson<CanvasCourse[]>(
          '/api/v1/courses?enrollment_state=completed&include[]=total_scores&include[]=term&per_page=100',
          { paginate: true },
        )
        .then(({ data }) => data.filter((course) => course?.id !== undefined))
        .finally(() => {
          this.completedCoursesPromise = undefined;
        });
    }
    return this.completedCoursesPromise;
  }
}
