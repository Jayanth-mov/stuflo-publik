export type CanvasErrorCode =
  | 'invalid_connection'
  | 'not_connected'
  | 'session_expired'
  | 'canvas_unreachable'
  | 'permission_denied'
  | 'not_found'
  | 'rate_limited'
  | 'page_limit'
  | 'invalid_response';

export interface CanvasCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  hostOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | string;
}

export interface CanvasConnection {
  canvasHost: string;
  cookies: CanvasCookie[];
  timeZone?: string;
  /** Saved cookie version, used to ignore failures from superseded sessions. */
  cookiesUpdatedAt?: string;
}

export interface LmsWarning {
  code: CanvasErrorCode;
  message: string;
  courseId?: string;
  endpoint?: string;
}

export interface LmsResult<T> {
  data: T;
  warnings: LmsWarning[];
}

export interface SessionStatus {
  connected: boolean;
  canvasHost: string;
  userId?: string;
  userName?: string;
  errorCode?: CanvasErrorCode;
}

export interface Course {
  id: string;
  name: string;
  courseCode: string | null;
  termName: string | null;
  workflowState: string | null;
  startAt: string | null;
  endAt: string | null;
  defaultView: string | null;
  url: string;
}

export interface CanvasResourceLink {
  label: string;
  url: string;
  apiUrl: string | null;
  kind: string | null;
  external: boolean;
}

export interface CanvasTab {
  id: string;
  label: string;
  type: string | null;
  hidden: boolean;
  visibility: string | null;
  position: number | null;
  htmlUrl: string;
}

export interface CourseOverview extends Course {
  teachers: Array<{ id: string; name: string; displayName: string | null }>;
  tabs: CanvasTab[];
  syllabusText: string;
  links: CanvasResourceLink[];
}

export type SubmissionStatus = 'unsubmitted' | 'submitted' | 'late' | 'missing' | 'graded' | 'excused';

export interface AssignmentSubmissionSummary {
  workflowState: string | null;
  submittedAt: string | null;
  submittedAtLocal: string | null;
  gradedAt: string | null;
  gradedAtLocal: string | null;
  attempt: number | null;
  score: number | null;
  grade: string | null;
  excused: boolean;
  late: boolean;
  missing: boolean;
}

export interface Assignment {
  id: string;
  courseId: string;
  course: string;
  name: string;
  dueAt: string | null;
  dueAtLocal: string | null;
  unlockAt: string | null;
  unlockAtLocal: string | null;
  lockAt: string | null;
  lockAtLocal: string | null;
  pointsPossible: number | null;
  submissionStatus: SubmissionStatus;
  submission: AssignmentSubmissionSummary | null;
  url: string;
}

export interface AssignmentQuery {
  courseId?: string;
  dueAfter?: string;
  dueBefore?: string;
  includeUndated?: boolean;
}

export interface CourseGrade {
  courseId: string;
  courseName: string;
  currentScore: number | null;
  currentGrade: string | null;
  url: string;
}

export interface Announcement {
  id: string;
  courseId: string;
  course: string;
  title: string;
  postedAt: string;
  postedAtLocal: string | null;
  authorId: string | null;
  authorName: string | null;
  message: string;
  url: string;
}

export interface AnnouncementQuery {
  courseId?: string;
  perCourseLimit?: number;
}

export interface ModuleItem {
  id: string;
  title: string;
  type: string;
  position: number | null;
  url: string | null;
  htmlUrl: string | null;
  externalUrl: string | null;
  contentId: string | null;
  pageUrl: string | null;
  published: boolean | null;
  locked: boolean;
}

export interface CourseModule {
  id: string;
  courseId: string;
  course: string;
  name: string;
  position: number | null;
  state: string | null;
  items: ModuleItem[];
}

export interface CourseSyllabus {
  courseId: string;
  courseName: string;
  syllabusBody: string;
  linkedFiles: string[];
  url: string;
}

export type CanvasSyllabusCandidateKind =
  | 'canvas_syllabus'
  | 'page'
  | 'file'
  | 'module_item'
  | 'course_tab'
  | 'external_link';

export interface CanvasSyllabusCandidate {
  kind: CanvasSyllabusCandidateKind;
  confidence: number;
  title: string;
  reason: string;
  url: string;
  text: string;
  fileId: string | null;
  pageUrl: string | null;
  links: CanvasResourceLink[];
}

export interface CanvasSyllabusDiscovery {
  courseId: string;
  courseName: string;
  found: boolean;
  searched: string[];
  candidates: CanvasSyllabusCandidate[];
}

export interface CanvasAssignmentDate {
  id: string | null;
  title: string | null;
  base: boolean;
  dueAt: string | null;
  dueAtLocal: string | null;
  unlockAt: string | null;
  unlockAtLocal: string | null;
  lockAt: string | null;
  lockAtLocal: string | null;
}

export interface CanvasSubmissionAttachment {
  id: string;
  name: string;
  contentType: string | null;
  sizeBytes: number | null;
  url: string | null;
  previewUrl: string | null;
}

export interface CanvasSubmissionComment {
  id: string;
  authorId: string | null;
  authorName: string | null;
  comment: string;
  createdAt: string | null;
  createdAtLocal: string | null;
  editedAt: string | null;
  editedAtLocal: string | null;
}

export interface CanvasRubricAssessment {
  criterionId: string;
  points: number | null;
  ratingId: string | null;
  comments: string;
}

export interface AssignmentSubmissionDetail extends AssignmentSubmissionSummary {
  id: string | null;
  submissionType: string | null;
  body: string;
  url: string | null;
  previewUrl: string | null;
  enteredScore: number | null;
  enteredGrade: string | null;
  secondsLate: number | null;
  latePolicyStatus: string | null;
  attachments: CanvasSubmissionAttachment[];
  comments: CanvasSubmissionComment[];
  rubricAssessment: CanvasRubricAssessment[];
}

export interface AssignmentDetail extends Assignment {
  assignmentGroupId: string | null;
  position: number | null;
  published: boolean | null;
  omitFromFinalGrade: boolean;
  allowedAttempts: number | null;
  hasSubmittedSubmissions: boolean;
  locked: boolean;
  lockExplanation: string | null;
  description: string;
  submissionTypes: string[];
  allowedExtensions: string[];
  gradingType: string | null;
  dates: CanvasAssignmentDate[];
  groupAssignment: {
    groupCategoryId: string | null;
    gradeGroupStudentsIndividually: boolean;
  };
  peerReview: {
    enabled: boolean;
    automatic: boolean;
    anonymous: boolean;
  };
  externalTool: {
    url: string;
    newTab: boolean;
    resourceLinkId: string | null;
  } | null;
  rubric: Array<{
    id: string;
    description: string;
    longDescription: string;
    points: number | null;
    ratings: Array<{
      id: string;
      description: string;
      longDescription: string;
      points: number | null;
    }>;
  }>;
  rubricSettings: {
    title: string | null;
    pointsPossible: number | null;
    freeFormCriterionComments: boolean;
    hideScoreTotal: boolean;
  } | null;
  submission: AssignmentSubmissionDetail | null;
  links: CanvasResourceLink[];
}

export interface CanvasPageSummary {
  courseId: string;
  course: string;
  pageUrl: string;
  title: string;
  frontPage: boolean;
  published: boolean | null;
  updatedAt: string | null;
  htmlUrl: string;
}

export interface CanvasPageDetail extends CanvasPageSummary {
  body: string;
  linkedFiles: string[];
  links: CanvasResourceLink[];
}

export interface CanvasDiscussion {
  id: string;
  courseId: string;
  course: string;
  title: string;
  message: string;
  postedAt: string | null;
  lastReplyAt: string | null;
  unreadCount: number | null;
  locked: boolean;
  url: string;
}

export interface CanvasFileSummary {
  id: string;
  courseId: string;
  course: string;
  name: string;
  contentType: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
  locked: boolean;
  htmlUrl: string;
  downloadUrl: string | null;
  folderId: string | null;
}

export interface CanvasFileDownload {
  file: CanvasFileSummary;
  bytes: ArrayBuffer;
}

export interface CanvasExternalToolLaunch {
  id: string | null;
  name: string | null;
  url: string;
}

export interface CanvasScheduleQuery {
  startDate: string;
  endDate: string;
  courseId?: string;
  includeAssignments?: boolean;
}

export interface CanvasScheduleItem {
  id: string;
  type: 'event' | 'assignment';
  courseId: string | null;
  course: string | null;
  title: string;
  description: string;
  startAt: string | null;
  startAtLocal: string | null;
  endAt: string | null;
  endAtLocal: string | null;
  location: string | null;
  url: string | null;
}

export type CanvasSearchKind =
  | 'assignment'
  | 'module'
  | 'page'
  | 'discussion'
  | 'announcement'
  | 'file'
  | 'quiz'
  | 'tab';

export interface CanvasSearchResult {
  kind: CanvasSearchKind;
  id: string;
  courseId: string;
  course: string;
  title: string;
  excerpt: string;
  url: string | null;
  score: number;
  fileId: string | null;
  pageUrl: string | null;
  authorId?: string | null;
  authorName?: string | null;
}

export interface CanvasCourseSearch {
  query: string;
  courseIds: string[];
  results: CanvasSearchResult[];
}

export interface CanvasBrowserPage {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  text: string;
  links: CanvasResourceLink[];
}

export interface CanvasQuizSummary {
  id: string;
  courseId: string;
  course: string;
  title: string;
  description: string;
  dueAt: string | null;
  dueAtLocal: string | null;
  pointsPossible: number | null;
  questionCount: number | null;
  published: boolean | null;
  htmlUrl: string;
}

export interface CanvasTodoItem {
  type: string;
  courseId: string | null;
  assignmentId: string | null;
  title: string;
  dueAt: string | null;
  dueAtLocal: string | null;
  htmlUrl: string | null;
}

export interface LmsAdapter {
  validateSession(): Promise<LmsResult<SessionStatus>>;
  listCourses(): Promise<LmsResult<Course[]>>;
  listCompletedCourses(): Promise<LmsResult<Course[]>>;
  getExternalToolLaunch(courseId: string, toolId: string): Promise<LmsResult<CanvasExternalToolLaunch>>;
  getCourseOverview(courseId: string): Promise<LmsResult<CourseOverview>>;
  listTabs(courseId: string): Promise<LmsResult<CanvasTab[]>>;
  listAssignments(args?: AssignmentQuery): Promise<LmsResult<Assignment[]>>;
  listGrades(): Promise<LmsResult<CourseGrade[]>>;
  listAnnouncements(args?: AnnouncementQuery): Promise<LmsResult<Announcement[]>>;
  listModules(courseId?: string): Promise<LmsResult<CourseModule[]>>;
  getSyllabus(courseId?: string): Promise<LmsResult<CourseSyllabus[]>>;
  findSyllabus(courseId: string): Promise<LmsResult<CanvasSyllabusDiscovery>>;
  getAssignmentDetail(courseId: string, assignmentId: string): Promise<LmsResult<AssignmentDetail>>;
  listPages(courseId?: string): Promise<LmsResult<CanvasPageSummary[]>>;
  getPage(courseId: string, pageUrl: string): Promise<LmsResult<CanvasPageDetail>>;
  listDiscussions(courseId?: string): Promise<LmsResult<CanvasDiscussion[]>>;
  listFiles(courseId?: string): Promise<LmsResult<CanvasFileSummary[]>>;
  downloadFile(courseId: string, fileId: string, maxBytes?: number): Promise<LmsResult<CanvasFileDownload>>;
  downloadExternalResource(url: string, maxBytes?: number): Promise<LmsResult<CanvasFileDownload>>;
  getSchedule(args: CanvasScheduleQuery): Promise<LmsResult<CanvasScheduleItem[]>>;
  searchCourse(query: string, courseId?: string, limit?: number): Promise<LmsResult<CanvasCourseSearch>>;
  listQuizzes(courseId?: string): Promise<LmsResult<CanvasQuizSummary[]>>;
  listTodos(): Promise<LmsResult<CanvasTodoItem[]>>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
