import {
  createCanvasInitializationRun,
  getLatestCanvasInitializationRun,
  getStudentByKey,
  listCanvasCourseSnapshots,
  listCanvasAttachments,
  markCanvasCourseSnapshotsInactive,
  updateCanvasInitializationRun,
  upsertCanvasCourseSnapshot,
} from '@stuflo/db';
import {
  CanvasAdapter,
  CanvasError,
  type CanvasConnection,
  type CanvasResourceLink,
  type CanvasSyllabusCandidate,
  type CanvasSyllabusDiscovery,
  type Course,
  type CourseModule,
  type CourseOverview,
} from '@stuflo/lms';
import type { StufloEnv } from '../env';
import { readCanvasPageInBrowser } from './canvas-browser';
import { loadCanvasForStudent, markCanvasConnectionForReconnect } from './canvas-connections';
import { openDatabase } from './database';
import {
  cleanupKnownInvalidCanvasInitializerArtifacts,
  storeCanvasResource,
  storeCanvasTextSnapshot,
} from './canvas-storage';

export type CanvasInitializationReason = 'canvas_connected' | 'manual' | 'semester_refresh';

export const CANVAS_INITIALIZATION_REFRESH_SECONDS = 7 * 24 * 60 * 60;
const AUTO_REFRESH_AGE_MS = CANVAS_INITIALIZATION_REFRESH_SECONDS * 1_000;
const STALE_RUN_AGE_MS = 2 * 60 * 60 * 1_000;
const MAX_ACTIVE_COURSES = 30;
const MAX_HISTORICAL_COURSES = 100;
const MAX_SAVED_SYLLABI_PER_COURSE = 2;
const SYLLABUS_SIGNAL = /syllabus|course outline|course policies|course guide/i;
const NON_DOCUMENT_SIGNAL = /quiz|exam|test|check[- ]?in/i;
const EXTERNAL_TOOL_PLACEHOLDER = /this tool needs to be loaded in a new browser window|load .+ in a new window|tool was successfully loaded in a new browser window/i;

type ExternalSystem = { name: string; url: string; kind: string; source: string };

type SimpleSyllabusLibraryItem = {
  code: string;
  title: string;
  sub_title?: string | null;
  term_name?: string | null;
  visibility?: string | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown Canvas initialization error.';
}

function externalSystemKind(value: string) {
  if (/simple syllabus|syllabus/i.test(value)) return 'syllabus';
  if (/ed discussion|piazza|packback|discussion|chatter/i.test(value)) return 'discussion';
  if (/pearson|mylab|mastering|mcgraw|connect|cengage|webassign|wiley|zybooks|achieve|vitalsource|textbook|ebook|mybusinesscourse|courseware|mindtap|perusall|top hat/i.test(value)) {
    return 'textbook_or_homework';
  }
  if (/gradescope|quest|homework|assessment|instapoll|registerblast/i.test(value)) return 'assessment';
  if (/zoom|panopto|kaltura|lecture|video/i.test(value)) return 'video';
  return 'external_tool';
}

function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 2_000) : null;
  } catch {
    return null;
  }
}

export function detectExternalSystems(
  overview: CourseOverview,
  modules: CourseModule[],
  syllabusLinks: CanvasResourceLink[],
) {
  const systems = new Map<string, ExternalSystem>();
  const add = (
    name: string,
    rawUrl: string | null | undefined,
    source: string,
    includeGeneric: boolean,
  ) => {
    const url = safeHttpUrl(rawUrl);
    if (!url) return;
    const normalizedName = name.trim().slice(0, 200) || new URL(url).hostname;
    const kind = externalSystemKind(`${normalizedName} ${url}`);
    if (!includeGeneric && kind === 'external_tool') return;
    const hostname = new URL(url).hostname.toLowerCase();
    const key = source === 'course_navigation'
      ? `${kind}|${normalizedName.toLowerCase()}|${hostname}`
      : `${kind}|${hostname}`;
    if (!systems.has(key)) {
      systems.set(key, {
        name: normalizedName,
        url,
        kind,
        source,
      });
    }
  };

  for (const tab of overview.tabs) {
    if (!tab.hidden && (tab.type === 'external' || tab.id.startsWith('context_external_tool_'))) {
      add(tab.label, tab.htmlUrl, 'course_navigation', true);
    }
  }
  for (const module of modules) {
    for (const item of module.items) {
      if (item.externalUrl) add(item.title, item.externalUrl, `module:${module.name}`, false);
    }
  }
  for (const link of [...overview.links, ...syllabusLinks]) {
    if (link.external) add(link.label, link.url, 'course_page', false);
  }
  return [...systems.values()].slice(0, 50);
}

async function stableSourceKey(
  canvasHost: string,
  courseId: string,
  kind: string,
  source: string,
) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${canvasHost}|course:${courseId}|initializer:${kind}:${hash}`;
}

function candidateFileName(courseName: string, candidate: CanvasSyllabusCandidate) {
  const extension = candidate.kind === 'page' || candidate.kind === 'canvas_syllabus' ? '.txt' : '';
  const title = candidate.title.replace(/[\\/]+/g, '_').trim().slice(0, 180);
  return `${title || `${courseName} Syllabus`}${extension}`;
}

export function isAutoSaveCandidate(candidate: CanvasSyllabusCandidate) {
  if (candidate.fileId) return true;
  if (candidate.kind === 'course_tab') return SYLLABUS_SIGNAL.test(`${candidate.title} ${candidate.url}`);
  if (candidate.kind === 'module_item' && NON_DOCUMENT_SIGNAL.test(candidate.title)) return false;
  if (candidate.kind === 'external_link') {
    return candidate.confidence >= 75 && SYLLABUS_SIGNAL.test(`${candidate.title} ${candidate.url}`);
  }
  if (candidate.text.trim().length >= 100) {
    return candidate.kind === 'canvas_syllabus' || candidate.confidence >= 75;
  }
  return candidate.confidence >= 75 && SYLLABUS_SIGNAL.test(`${candidate.title} ${candidate.url}`);
}

function usableRenderedSyllabusText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length >= 500 && !EXTERNAL_TOOL_PLACEHOLDER.test(normalized);
}

function usableDownloadedSyllabusHtml(bytes: ArrayBuffer) {
  if (bytes.byteLength < 500) return false;
  const html = new TextDecoder().decode(bytes);
  return !EXTERNAL_TOOL_PLACEHOLDER.test(html) &&
    /syllabus|course title|course information|grading policy|instructor/i.test(html);
}

function simpleSyllabusUniqueNumbers(courseName: string) {
  return [...new Set(courseName.match(/\b\d{5}\b/g) || [])];
}

function inferredTermName(courseName: string) {
  const match = courseName.match(/\b(Fa|Sp|Su)(\d{2})\b/i);
  if (!match) return null;
  const season = match[1]!.toLowerCase() === 'fa'
    ? 'Fall'
    : match[1]!.toLowerCase() === 'sp'
      ? 'Spring'
      : 'Summer';
  return `${season} 20${match[2]}`;
}

function simpleSyllabusDocumentPath(item: SimpleSyllabusLibraryItem) {
  const label = `${item.term_name || ''} ${item.title}${item.sub_title ? ` - ${item.sub_title}` : ''}`.trim();
  const slug = encodeURIComponent(label.replace(/[ _.\-/]+/g, '-'))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
  return `${encodeURIComponent(item.code)}/${slug}`;
}

export function selectSimpleSyllabusLibraryItem(
  courseName: string,
  items: SimpleSyllabusLibraryItem[],
) {
  const uniqueNumbers = simpleSyllabusUniqueNumbers(courseName);
  const expectedTerm = inferredTermName(courseName);
  const normalizedCourse = courseName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return items
    .filter((item) => item.visibility === 'general_public' && /^[a-z0-9]+$/i.test(item.code))
    .map((item) => {
      const title = `${item.title} ${item.sub_title || ''}`;
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      let score = uniqueNumbers.some((number) => new RegExp(`\\b${number}\\b`).test(title)) ? 100 : 0;
      if (expectedTerm && item.term_name === expectedTerm) score += 60;
      if (normalizedTitle && (
        normalizedCourse.includes(normalizedTitle) || normalizedTitle.includes(normalizedCourse)
      )) score += 30;
      return { item, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.item || null;
}

export function simpleSyllabusDocumentUrls(host: string, item: SimpleSyllabusLibraryItem) {
  const safeHost = host.toLowerCase();
  if (!/^[a-z0-9.-]+\.simplesyllabus\.com$/.test(safeHost)) {
    throw new Error('Simple Syllabus host is invalid.');
  }
  const path = simpleSyllabusDocumentPath(item);
  return {
    htmlUrl: `https://${safeHost}/api2/doc-html/${path}`,
    sourceUrl: `https://${safeHost}/en-US/doc/${encodeURIComponent(item.code)}`,
  };
}

export function inferSimpleSyllabusHost(canvasHost: string, tabTitle: string) {
  if (!/simple syllabus/i.test(tabTitle)) return null;
  const canvasTenant = canvasHost.toLowerCase().match(/^([a-z0-9-]+)\.instructure\.com$/)?.[1];
  return canvasTenant ? `${canvasTenant}.simplesyllabus.com` : null;
}

function parseSimpleSyllabusLibraryItems(text: string) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return [] as SimpleSyllabusLibraryItem[];
    const body = JSON.parse(text.slice(start, end + 1)) as { items?: SimpleSyllabusLibraryItem[] };
    return body.items || [];
  } catch {
    return [] as SimpleSyllabusLibraryItem[];
  }
}

async function findPublicSimpleSyllabus(
  env: StufloEnv,
  connection: CanvasConnection,
  host: string,
  courseName: string,
) {
  const items: SimpleSyllabusLibraryItem[] = [];
  const diagnostics: string[] = [];
  for (const uniqueNumber of simpleSyllabusUniqueNumbers(courseName).slice(0, 3)) {
    const url = new URL(`https://${host}/api2/doc-library-search`);
    url.searchParams.set('search', uniqueNumber);
    url.searchParams.set('page', '0');
    url.searchParams.set('page_size', '50');
    let found: SimpleSyllabusLibraryItem[] = [];
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const responseText = await response.text();
      if (response.ok) found = parseSimpleSyllabusLibraryItems(responseText);
      diagnostics.push(`fetch:${response.status}/${responseText.length}/${found.length}`);
    } catch (error) {
      diagnostics.push(`fetch:error:${errorMessage(error)}`);
      // Browser Rendering below can still reach institutions that reject Worker fetch traffic.
    }
    if (found.length === 0) {
      try {
        const rendered = await readCanvasPageInBrowser(
          env,
          connection,
          url.href,
          { allowExternalNavigation: true },
        );
        found = parseSimpleSyllabusLibraryItems(rendered.text);
        diagnostics.push(`browser:${rendered.text.length}/${found.length}`);
      } catch (error) {
        diagnostics.push(`browser:error:${errorMessage(error)}`);
        // Public-library lookup is only a fallback for an otherwise valid Canvas LTI launch.
      }
    }
    for (const item of found) {
      if (!items.some((existing) => existing.code === item.code)) items.push(item);
    }
  }
  const selected = selectSimpleSyllabusLibraryItem(courseName, items);
  if (!selected) {
    throw new Error(`Simple Syllabus library did not return a matching public document (${diagnostics.join('; ')}).`);
  }
  return selected;
}

async function savePublicSimpleSyllabus(
  env: StufloEnv,
  adapter: CanvasAdapter,
  studentId: string,
  connection: CanvasConnection,
  courseId: string,
  courseName: string,
  host: string,
  sourceKey?: string,
  restoreDeleted = false,
) {
  const item = await findPublicSimpleSyllabus(env, connection, host, courseName);
  if (!item) return null;
  const urls = simpleSyllabusDocumentUrls(host, item);
  const download = await adapter.downloadExternalResource(urls.htmlUrl);
  const html = new TextDecoder().decode(download.data.bytes);
  if (download.data.bytes.byteLength < 500 || !/course title|course information|grading policy|instructor/i.test(html)) {
    return null;
  }
  return storeCanvasResource(env, studentId, {
    bytes: download.data.bytes,
    fileName: `${courseName} Syllabus.html`,
    mimeType: 'text/html',
    sourceKey: sourceKey || await stableSourceKey(connection.canvasHost, courseId, 'simple-syllabus', urls.htmlUrl),
    sourceUrl: urls.sourceUrl,
    canvasHost: connection.canvasHost,
    courseId,
    courseName,
    purpose: 'syllabus',
    restoreDeleted,
  });
}

async function saveDownloadedSyllabus(
  env: StufloEnv,
  studentId: string,
  connection: CanvasConnection,
  courseId: string,
  courseName: string,
  candidate: CanvasSyllabusCandidate,
  restoreDeleted = false,
) {
  const adapter = new CanvasAdapter(connection);
  if (candidate.fileId) {
    const download = await adapter.downloadFile(courseId, candidate.fileId);
    return storeCanvasResource(env, studentId, {
      bytes: download.data.bytes,
      fileName: download.data.file.name,
      mimeType: download.data.file.contentType || 'application/octet-stream',
      sourceKey: await stableSourceKey(connection.canvasHost, courseId, 'file', candidate.url),
      sourceUrl: candidate.url,
      canvasHost: connection.canvasHost,
      courseId,
      courseName,
      purpose: 'syllabus',
      restoreDeleted,
    });
  }

  if (candidate.text.trim().length >= 100) {
    return storeCanvasTextSnapshot(env, studentId, {
      text: candidate.text,
      fileName: candidateFileName(courseName, candidate),
      sourceKey: await stableSourceKey(connection.canvasHost, courseId, candidate.kind, candidate.url),
      sourceUrl: candidate.url,
      canvasHost: connection.canvasHost,
      courseId,
      courseName,
      purpose: 'syllabus',
      restoreDeleted,
    });
  }

  const source = new URL(candidate.url, `https://${connection.canvasHost}`);
  if (source.origin !== `https://${connection.canvasHost}`) {
    if (source.hostname.toLowerCase().endsWith('.simplesyllabus.com')) {
      return savePublicSimpleSyllabus(
        env,
        adapter,
        studentId,
        connection,
        courseId,
        courseName,
        source.hostname,
        await stableSourceKey(connection.canvasHost, courseId, 'external', source.href),
        restoreDeleted,
      );
    }
    const download = await adapter.downloadExternalResource(source.href);
    if ((download.data.file.contentType || '').toLowerCase().startsWith('text/html')) {
      if (!usableDownloadedSyllabusHtml(download.data.bytes)) {
        throw new Error('The external link returned a launcher or app shell instead of a readable syllabus.');
      }
    }
    return storeCanvasResource(env, studentId, {
      bytes: download.data.bytes,
      fileName: download.data.file.name || candidateFileName(courseName, candidate),
      mimeType: download.data.file.contentType || 'application/octet-stream',
      sourceKey: await stableSourceKey(connection.canvasHost, courseId, 'external', source.href),
      sourceUrl: source.href,
      canvasHost: connection.canvasHost,
      courseId,
      courseName,
      purpose: 'syllabus',
      restoreDeleted,
    });
  }

  const browserAttempts: Array<{ url: string; allowExternalNavigation: boolean }> = [];
  if (candidate.kind === 'course_tab') {
    const toolId = source.pathname.match(/\/external_tools\/(\d+)/)?.[1];
    if (toolId) {
      try {
        const launch = await adapter.getExternalToolLaunch(courseId, toolId);
        browserAttempts.push({ url: launch.data.url, allowExternalNavigation: true });
      } catch {
        // The normal Canvas tab remains a safe fallback when sessionless launch is unavailable.
      }
    }
  }
  if (!browserAttempts.some((attempt) => attempt.url === source.href)) {
    browserAttempts.push({
      url: source.href,
      allowExternalNavigation: candidate.kind === 'course_tab',
    });
  }

  let lastBrowserError: unknown = null;
  let simpleSyllabusHost: string | null = null;
  const browserDiagnostics: string[] = [];
  for (const attempt of browserAttempts) {
    try {
      const rendered = await readCanvasPageInBrowser(
        env,
        connection,
        attempt.url,
        { allowExternalNavigation: attempt.allowExternalNavigation },
      );
      browserDiagnostics.push(
        `${new URL(rendered.finalUrl).hostname} title=${JSON.stringify(rendered.title.slice(0, 80))} text=${rendered.text.length} links=${rendered.links.length}`,
      );
      const renderedHost = new URL(rendered.finalUrl).hostname.toLowerCase();
      if (renderedHost.endsWith('.simplesyllabus.com')) simpleSyllabusHost = renderedHost;
      const linkedDocument = rendered.links.find((link) =>
        link.external && (/\.(pdf|docx?)(?:$|[?#])/i.test(link.url) || /syllabus/i.test(`${link.label} ${link.url}`)),
      );
      if (linkedDocument) {
        try {
          const linkedUrl = new URL(linkedDocument.url);
          if (linkedUrl.hostname.toLowerCase().endsWith('.simplesyllabus.com')) {
            const stored = await savePublicSimpleSyllabus(
              env,
              adapter,
              studentId,
              connection,
              courseId,
              courseName,
              linkedUrl.hostname,
              await stableSourceKey(connection.canvasHost, courseId, 'embedded', linkedDocument.url),
              restoreDeleted,
            );
            if (stored) return stored;
          }
          const download = await adapter.downloadExternalResource(linkedDocument.url);
          if ((download.data.file.contentType || '').toLowerCase().startsWith('text/html') &&
            !usableDownloadedSyllabusHtml(download.data.bytes)) {
            throw new Error('The embedded link returned a launcher or app shell instead of a readable syllabus.');
          }
          return await storeCanvasResource(env, studentId, {
            bytes: download.data.bytes,
            fileName: download.data.file.name || candidateFileName(courseName, candidate),
            mimeType: download.data.file.contentType || 'application/octet-stream',
            sourceKey: await stableSourceKey(connection.canvasHost, courseId, 'embedded', linkedDocument.url),
            sourceUrl: linkedDocument.url,
            canvasHost: connection.canvasHost,
            courseId,
            courseName,
            purpose: 'syllabus',
            restoreDeleted,
          });
        } catch {
          // The rendered text below may still be a durable, readable syllabus snapshot.
        }
      }
      if (!usableRenderedSyllabusText(rendered.text)) continue;
      return await storeCanvasTextSnapshot(env, studentId, {
        text: rendered.text,
        fileName: `${courseName} Syllabus.txt`,
        sourceKey: await stableSourceKey(connection.canvasHost, courseId, 'rendered', source.href),
        sourceUrl: source.href,
        canvasHost: connection.canvasHost,
        courseId,
        courseName,
        purpose: 'syllabus',
        restoreDeleted,
      });
    } catch (error) {
      lastBrowserError = error;
    }
  }
  simpleSyllabusHost ||= inferSimpleSyllabusHost(connection.canvasHost, candidate.title);
  if (simpleSyllabusHost) {
    const stored = await savePublicSimpleSyllabus(
      env,
      adapter,
      studentId,
      connection,
      courseId,
      courseName,
      simpleSyllabusHost,
      undefined,
      restoreDeleted,
    );
    if (stored) return stored;
  }
  if (lastBrowserError && browserAttempts.length === 1) throw lastBrowserError;
  if (candidate.kind === 'course_tab' && browserDiagnostics.length > 0) {
    throw new Error(`External syllabus launch returned no readable document (${browserDiagnostics.join('; ')}).`);
  }
  return null;
}

async function saveSyllabusCandidates(
  env: StufloEnv,
  studentId: string,
  connection: CanvasConnection,
  discovery: CanvasSyllabusDiscovery,
  restoreDeleted = false,
) {
  if (!discovery.found) {
    return { status: 'not_found', sourceUrl: null, attachmentIds: [] as string[], warnings: [] as string[] };
  }

  const candidates = discovery.candidates
    .filter(isAutoSaveCandidate)
    .sort((left, right) => {
      const leftPriority = left.fileId ? 2 : left.text ? 1 : 0;
      const rightPriority = right.fileId ? 2 : right.text ? 1 : 0;
      return rightPriority - leftPriority || right.confidence - left.confidence;
    });
  const attachmentIds: string[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    if (attachmentIds.length >= MAX_SAVED_SYLLABI_PER_COURSE) break;
    try {
      const stored = await saveDownloadedSyllabus(
        env,
        studentId,
        connection,
        discovery.courseId,
        discovery.courseName,
        candidate,
        restoreDeleted,
      );
      if (stored && !attachmentIds.includes(stored.id)) {
        attachmentIds.push(stored.id);
      } else if (!stored) {
        warnings.push(`${candidate.title}: Canvas did not return readable syllabus document content.`);
      }
    } catch (error) {
      warnings.push(`${candidate.title}: ${errorMessage(error)}`);
    }
  }
  return {
    status: attachmentIds.length > 0 ? 'stored' : 'found_not_stored',
    sourceUrl: candidates[0]?.url || null,
    attachmentIds,
    warnings,
  };
}

function browserLinksFromDiscovery(discovery: CanvasSyllabusDiscovery) {
  return discovery.candidates.flatMap((candidate) => candidate.links).filter((link) => link.external);
}

export async function queueCanvasInitialization(
  env: StufloEnv,
  studentKey: string,
  reason: CanvasInitializationReason,
  force = false,
) {
  const opened = openDatabase(env);
  try {
    const student = await getStudentByKey(opened.db, studentKey);
    if (!student) throw new Error('Student does not exist in Postgres.');
    const connection = await loadCanvasForStudent(env, studentKey);
    if (!connection) throw new Error('Canvas is not connected.');
    const latest = await getLatestCanvasInitializationRun(opened.db, student.id);
    if (latest && ['queued', 'running'].includes(latest.status)) {
      if (Date.now() - latest.updatedAt.getTime() < STALE_RUN_AGE_MS) {
        return { queued: false, existing: true, run: latest };
      }
      await updateCanvasInitializationRun(opened.db, {
        runId: latest.id,
        status: 'failed',
        errorMessage: 'This Canvas initialization did not finish and was replaced by a new run.',
        completedAt: new Date(),
      });
    }
    if (
      !force &&
      latest?.completedAt &&
      latest.canvasHost === connection.canvasHost &&
      Date.now() - latest.completedAt.getTime() < AUTO_REFRESH_AGE_MS
    ) {
      return { queued: false, fresh: true, run: latest };
    }
    const run = await createCanvasInitializationRun(opened.db, {
      studentId: student.id,
      canvasHost: connection.canvasHost,
      reason,
    });
    return { queued: true, run };
  } finally {
    await opened.close();
  }
}

export async function failCanvasInitializationRun(
  env: StufloEnv,
  runId: string,
  error: unknown,
) {
  const opened = openDatabase(env);
  try {
    return updateCanvasInitializationRun(opened.db, {
      runId,
      status: 'failed',
      errorMessage: errorMessage(error),
      completedAt: new Date(),
    });
  } finally {
    await opened.close();
  }
}

export async function performCanvasInitialization(
  env: StufloEnv,
  studentKey: string,
  runId: string,
) {
  const startedAt = new Date();
  const opened = openDatabase(env);
  let student: Awaited<ReturnType<typeof getStudentByKey>> | null = null;
  let restoreDeleted = false;
  try {
    student = await getStudentByKey(opened.db, studentKey);
    if (!student) throw new Error('Student does not exist in Postgres.');
    const latest = await getLatestCanvasInitializationRun(opened.db, student.id);
    restoreDeleted = latest?.reason === 'manual';
    if (!latest || latest.id !== runId) {
      return { status: 'superseded', coursesCompleted: 0, syllabiStored: 0 };
    }
    if (latest.status === 'running' && latest.startedAt) {
      return {
        status: 'running',
        coursesCompleted: latest.coursesCompleted,
        syllabiStored: latest.syllabiStored,
      };
    }
    if (['completed', 'partial', 'failed'].includes(latest.status) && latest.completedAt) {
      return {
        status: latest.status,
        coursesCompleted: latest.coursesCompleted,
        syllabiStored: latest.syllabiStored,
      };
    }
    await updateCanvasInitializationRun(opened.db, {
      runId,
      status: 'running',
      startedAt,
      errorMessage: null,
    });
  } finally {
    await opened.close();
  }

  if (!student) throw new Error('Student does not exist in Postgres.');
  const warnings: string[] = [];
  let coursesCompleted = 0;
  let syllabiFound = 0;
  let syllabiStored = 0;
  let courseFailures = 0;
  const currentSyllabusAttachmentIds = new Set<string>();
  let connection: CanvasConnection | undefined;

  try {
    connection = await loadCanvasForStudent(env, studentKey);
    if (!connection) throw new Error('Canvas is not connected.');
    const adapter = new CanvasAdapter(connection);
    const [activeResult, completedResult, gradesResult] = await Promise.all([
      adapter.listCourses(),
      adapter.listCompletedCourses().catch((error) => {
        warnings.push(`Past course catalog: ${errorMessage(error)}`);
        return { data: [] as Course[], warnings: [] };
      }),
      adapter.listGrades().catch((error) => {
        warnings.push(`Grades: ${errorMessage(error)}`);
        return { data: [], warnings: [] };
      }),
    ]);
    const activeCourses = activeResult.data.slice(0, MAX_ACTIVE_COURSES);
    const activeIds = new Set(activeCourses.map((course) => course.id));
    const historicalCourses = completedResult.data
      .filter((course) => !activeIds.has(course.id))
      .slice(0, MAX_HISTORICAL_COURSES);
    if (activeResult.data.length > MAX_ACTIVE_COURSES) {
      warnings.push(`Only the first ${MAX_ACTIVE_COURSES} active Canvas courses were initialized.`);
    }

    const database = openDatabase(env);
    let existingByCourse = new Map<string, Awaited<ReturnType<typeof listCanvasCourseSnapshots>>[number]>();
    try {
      const existing = await listCanvasCourseSnapshots(database.db, student.id, 200);
      existingByCourse = new Map(existing.map((course) => [course.courseId, course]));
      await markCanvasCourseSnapshotsInactive(database.db, student.id, connection.canvasHost);
      for (const course of historicalCourses) {
        const previous = existingByCourse.get(course.id);
        await upsertCanvasCourseSnapshot(database.db, {
          studentId: student.id,
          canvasHost: connection.canvasHost,
          courseId: course.id,
          courseName: course.name,
          courseCode: course.courseCode,
          termName: course.termName || previous?.termName || null,
          courseUrl: course.url,
          isActive: false,
          syllabusStatus: previous?.syllabusStatus || 'not_scanned',
          syllabusSourceUrl: previous?.syllabusSourceUrl || null,
          syllabusAttachmentIds: previous?.syllabusAttachmentIds || [],
          externalSystems: previous?.externalSystems || [],
          snapshot: previous?.snapshot || { course },
          initializedAt: previous?.initializedAt || startedAt,
        });
      }
      await updateCanvasInitializationRun(database.db, {
        runId,
        coursesTotal: activeCourses.length,
      });
    } finally {
      await database.close();
    }

    for (const course of activeCourses) {
      try {
        const [overviewResult, assignmentsResult, modulesResult, announcementsResult, discoveryResult] =
          await Promise.all([
            adapter.getCourseOverview(course.id),
            adapter.listAssignments({ courseId: course.id, includeUndated: true }),
            adapter.listModules(course.id),
            adapter.listAnnouncements({ courseId: course.id, perCourseLimit: 25 }),
            adapter.findSyllabus(course.id),
          ]);
        const overview = overviewResult.data;
        const discovery = discoveryResult.data;
        const syllabus = await saveSyllabusCandidates(env, student.id, connection, discovery, restoreDeleted);
        if (discovery.found) syllabiFound += 1;
        if (syllabus.attachmentIds.length > 0) syllabiStored += 1;
        for (const attachmentId of syllabus.attachmentIds) currentSyllabusAttachmentIds.add(attachmentId);
        warnings.push(...syllabus.warnings.map((warning) => `${course.name}: ${warning}`));
        const courseWarnings = [
          ...overviewResult.warnings,
          ...assignmentsResult.warnings,
          ...modulesResult.warnings,
          ...announcementsResult.warnings,
          ...discoveryResult.warnings,
        ].map((warning) => warning.message);
        const externalSystems = detectExternalSystems(
          overview,
          modulesResult.data,
          browserLinksFromDiscovery(discovery),
        );
        const grade = gradesResult.data.find((item) => item.courseId === course.id) || null;
        const database = openDatabase(env);
        try {
          await upsertCanvasCourseSnapshot(database.db, {
            studentId: student.id,
            canvasHost: connection.canvasHost,
            courseId: course.id,
            courseName: overview.name,
            courseCode: overview.courseCode,
            termName: overview.termName,
            courseUrl: overview.url,
            isActive: true,
            syllabusStatus: syllabus.status,
            syllabusSourceUrl: syllabus.sourceUrl,
            syllabusAttachmentIds: syllabus.attachmentIds,
            externalSystems,
            initializedAt: new Date(),
            snapshot: {
              course: {
                id: overview.id,
                name: overview.name,
                courseCode: overview.courseCode,
                termName: overview.termName,
                startAt: overview.startAt,
                endAt: overview.endAt,
                workflowState: overview.workflowState,
                defaultView: overview.defaultView,
                url: overview.url,
              },
              teachers: overview.teachers,
              tabs: overview.tabs,
              grade,
              assignmentCount: assignmentsResult.data.length,
              assignments: assignmentsResult.data.slice(0, 250),
              moduleCount: modulesResult.data.length,
              modules: modulesResult.data.slice(0, 80).map((module) => ({
                ...module,
                items: module.items.slice(0, 80),
              })),
              announcementCount: announcementsResult.data.length,
              announcements: announcementsResult.data.slice(0, 25),
              externalSystems,
              syllabus: {
                found: discovery.found,
                status: syllabus.status,
                sourceUrl: syllabus.sourceUrl,
                attachmentIds: syllabus.attachmentIds,
                searched: discovery.searched,
                candidates: discovery.candidates.slice(0, 8).map((candidate) => ({
                  kind: candidate.kind,
                  confidence: candidate.confidence,
                  title: candidate.title,
                  reason: candidate.reason,
                  url: candidate.url,
                  fileId: candidate.fileId,
                  pageUrl: candidate.pageUrl,
                })),
              },
              warnings: courseWarnings.slice(0, 50),
            },
          });
        } finally {
          await database.close();
        }
      } catch (error) {
        courseFailures += 1;
        warnings.push(`${course.name}: ${errorMessage(error)}`);
        const previous = existingByCourse.get(course.id);
        for (const attachmentId of previous?.syllabusAttachmentIds || []) {
          currentSyllabusAttachmentIds.add(attachmentId);
        }
        const database = openDatabase(env);
        try {
          await upsertCanvasCourseSnapshot(database.db, {
            studentId: student.id,
            canvasHost: connection.canvasHost,
            courseId: course.id,
            courseName: course.name,
            courseCode: course.courseCode,
            termName: previous?.termName || null,
            courseUrl: course.url,
            isActive: true,
            syllabusStatus: previous?.syllabusStatus || 'scan_failed',
            syllabusSourceUrl: previous?.syllabusSourceUrl || null,
            syllabusAttachmentIds: previous?.syllabusAttachmentIds || [],
            externalSystems: previous?.externalSystems || [],
            snapshot: previous?.snapshot || { course, initializationError: errorMessage(error) },
            initializedAt: previous?.initializedAt || startedAt,
          });
        } finally {
          await database.close();
        }
      }

      coursesCompleted += 1;
      const progressDb = openDatabase(env);
      try {
        await updateCanvasInitializationRun(progressDb.db, {
          runId,
          coursesCompleted,
          syllabiFound,
          syllabiStored,
          warnings: warnings.slice(0, 100),
        });
      } finally {
        await progressDb.close();
      }
    }

    let cleanedInvalidArtifacts = 0;
    try {
      cleanedInvalidArtifacts = await cleanupKnownInvalidCanvasInitializerArtifacts(
        env,
        student.id,
        currentSyllabusAttachmentIds,
      );
    } catch (error) {
      warnings.push(`Storage cleanup: ${errorMessage(error)}`);
    }
    const completedAt = new Date();
    const finalDb = openDatabase(env);
    try {
      await updateCanvasInitializationRun(finalDb.db, {
        runId,
        status: courseFailures > 0 ? 'partial' : 'completed',
        coursesTotal: activeCourses.length,
        coursesCompleted,
        syllabiFound,
        syllabiStored,
        summary: {
          activeCourses: activeCourses.length,
          historicalCourses: historicalCourses.length,
          courseFailures,
          cleanedInvalidArtifacts,
        },
        warnings: warnings.slice(0, 100),
        completedAt,
      });
    } finally {
      await finalDb.close();
    }
    return { status: courseFailures > 0 ? 'partial' : 'completed', coursesCompleted, syllabiStored };
  } catch (error) {
    const failedDb = openDatabase(env);
    try {
      await updateCanvasInitializationRun(failedDb.db, {
        runId,
        status: 'failed',
        coursesCompleted,
        syllabiFound,
        syllabiStored,
        warnings: warnings.slice(0, 100),
        errorMessage: errorMessage(error),
        completedAt: new Date(),
      });
    } finally {
      await failedDb.close();
    }
    if (connection && error instanceof CanvasError && ['session_expired', 'not_connected', 'invalid_connection'].includes(error.code)) {
      await markCanvasConnectionForReconnect(env, studentKey, error.code, connection).catch(() => undefined);
    }
    throw error;
  }
}

export function visibleSyllabusReferences(course: { syllabusAttachmentIds: string[]; syllabusStatus: string }, storedIds: Set<string>) {
  const attachmentIds = course.syllabusAttachmentIds.filter((id) => storedIds.has(id));
  return { attachmentIds, status: course.syllabusStatus === 'stored' && attachmentIds.length === 0 ? 'found_not_stored' : course.syllabusStatus };
}

export async function getCanvasInitializationOverview(env: StufloEnv, studentKey: string) {
  const opened = openDatabase(env);
  try {
    const student = await getStudentByKey(opened.db, studentKey);
    if (!student) return null;
    const [run, courses, storedFiles] = await Promise.all([
      getLatestCanvasInitializationRun(opened.db, student.id),
      listCanvasCourseSnapshots(opened.db, student.id, 200),
      listCanvasAttachments(opened.db, student.id),
    ]);
    const storedIds = new Set(storedFiles.map((file) => file.id));
    return {
      run,
      courses: courses.map((course) => ({
        id: course.id,
        canvasHost: course.canvasHost,
        courseId: course.courseId,
        courseName: course.courseName,
        courseCode: course.courseCode,
        termName: course.termName,
        courseUrl: course.courseUrl,
        isActive: course.isActive,
        syllabusStatus: visibleSyllabusReferences(course, storedIds).status,
        syllabusSourceUrl: course.syllabusSourceUrl,
        syllabusAttachmentIds: visibleSyllabusReferences(course, storedIds).attachmentIds,
        externalSystems: course.externalSystems,
        initializedAt: course.initializedAt,
      })),
    };
  } finally {
    await opened.close();
  }
}

export async function getCanvasKnowledgeContext(env: StufloEnv, studentId: string) {
  const opened = openDatabase(env);
  try {
    const [courses, storedFiles] = await Promise.all([listCanvasCourseSnapshots(opened.db, studentId, 50), listCanvasAttachments(opened.db, studentId)]);
    const storedIds = new Set(storedFiles.map((file) => file.id));
    return courses.filter((course) => course.isActive).slice(0, 30).map((course) => {
      const snapshot = course.snapshot as {
        teachers?: unknown;
        grade?: unknown;
        assignmentCount?: unknown;
        assignments?: unknown[];
        moduleCount?: unknown;
        modules?: Array<{ name?: unknown; items?: Array<{ title?: unknown; type?: unknown }> }>;
        announcements?: unknown[];
      };
      return {
        courseId: course.courseId,
        courseName: course.courseName,
        courseCode: course.courseCode,
        termName: course.termName,
        courseUrl: course.courseUrl,
        teachers: snapshot.teachers || [],
        grade: snapshot.grade || null,
        assignmentCount: snapshot.assignmentCount || 0,
        assignments: (snapshot.assignments || []).slice(0, 20),
        moduleCount: snapshot.moduleCount || 0,
        modules: (snapshot.modules || []).slice(0, 30).map((module) => ({
          name: module.name,
          items: (module.items || []).slice(0, 20),
        })),
        announcements: (snapshot.announcements || []).slice(0, 8),
        syllabus: {
          status: visibleSyllabusReferences(course, storedIds).status,
          sourceUrl: course.syllabusSourceUrl,
          attachmentIds: visibleSyllabusReferences(course, storedIds).attachmentIds,
        },
        externalSystems: course.externalSystems,
        initializedAt: course.initializedAt,
      };
    });
  } finally {
    await opened.close();
  }
}
