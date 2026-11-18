import { describe, expect, it } from 'vitest';
import type { CanvasResourceLink, CourseModule, CourseOverview } from '@stuflo/lms';
import {
  CANVAS_INITIALIZATION_REFRESH_SECONDS,
  detectExternalSystems,
  inferSimpleSyllabusHost,
  isAutoSaveCandidate,
  selectSimpleSyllabusLibraryItem,
  simpleSyllabusDocumentUrls,
} from '../src/services/canvas-initializer';
import { isKnownInvalidCanvasInitializerArtifact } from '../src/services/canvas-storage';

describe('Canvas course initializer', () => {
  it('rescans connected Canvas courses every seven days', () => {
    expect(CANVAS_INITIALIZATION_REFRESH_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('stores syllabus documents but skips links and quizzes merely mentioned by a syllabus', () => {
    expect(isAutoSaveCandidate({
      kind: 'course_tab',
      confidence: 95,
      title: 'UT Simple Syllabus',
      reason: 'Course navigation tab',
      url: 'https://school.instructure.com/courses/10/external_tools/122213',
      text: '',
      fileId: null,
      pageUrl: null,
      links: [],
    })).toBe(true);
    expect(isAutoSaveCandidate({
      kind: 'external_link',
      confidence: 80,
      title: 'Book in-person training',
      reason: 'Linked from the Canvas syllabus body',
      url: 'https://outlook.office365.com/bookings/example',
      text: '',
      fileId: null,
      pageUrl: null,
      links: [],
    })).toBe(false);
    expect(isAutoSaveCandidate({
      kind: 'module_item',
      confidence: 86,
      title: 'Syllabus Quiz',
      reason: 'Syllabus-like module item',
      url: 'https://school.instructure.com/courses/10/quizzes/1',
      text: '',
      fileId: null,
      pageUrl: null,
      links: [],
    })).toBe(false);
  });

  it('keeps distinct platforms without treating every external course link as a system', () => {
    const overview = {
      tabs: [
        {
          id: 'context_external_tool_122213',
          label: 'UT Simple Syllabus',
          type: 'external',
          hidden: false,
          visibility: null,
          position: 1,
          htmlUrl: 'https://school.instructure.com/courses/10/external_tools/122213',
        },
        {
          id: 'context_external_tool_77046',
          label: 'Ed Discussion',
          type: 'external',
          hidden: false,
          visibility: null,
          position: 2,
          htmlUrl: 'https://school.instructure.com/courses/10/external_tools/77046',
        },
      ],
      links: [
        { label: 'Background reading', url: 'https://wikipedia.org/example', apiUrl: null, kind: null, external: true },
        { label: 'Course textbook', url: 'https://books.example.edu/title', apiUrl: null, kind: null, external: true },
      ],
    } as CourseOverview;
    const modules = [{
      id: '1',
      name: 'Homework',
      position: 1,
      state: null,
      items: [
        { id: '1', title: 'Chapter 1', type: 'ExternalUrl', position: 1, htmlUrl: null, externalUrl: 'https://mybusinesscourse.com/chapter/1', contentId: null, pageUrl: null, published: true, locked: false },
        { id: '2', title: 'Chapter 2', type: 'ExternalUrl', position: 2, htmlUrl: null, externalUrl: 'https://mybusinesscourse.com/chapter/2', contentId: null, pageUrl: null, published: true, locked: false },
        { id: '3', title: 'Office hours signup', type: 'ExternalUrl', position: 3, htmlUrl: null, externalUrl: 'https://outlook.office365.com/bookings/example', contentId: null, pageUrl: null, published: true, locked: false },
      ],
    }] as CourseModule[];
    const syllabusLinks: CanvasResourceLink[] = [];

    const systems = detectExternalSystems(overview, modules, syllabusLinks);

    expect(systems.map((system) => system.name)).toEqual([
      'UT Simple Syllabus',
      'Ed Discussion',
      'Chapter 1',
      'Course textbook',
    ]);
    expect(systems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Background reading' }),
      expect.objectContaining({ name: 'Office hours signup' }),
      expect.objectContaining({ name: 'Chapter 2' }),
    ]));
  });

  it('selects the current public Simple Syllabus record and builds its content URL', () => {
    const selected = selectSimpleSyllabusLibraryItem(
      'Fa26 - ELEMENTS OF SOFTWARE DESIGN (54960/54965)',
      [
        {
          code: 'older',
          title: 'C S 313E 54960',
          sub_title: 'ELEMENTS OF SOFTWARE DESIGN',
          term_name: 'Fall 2025',
          visibility: 'general_public',
        },
        {
          code: '7574fsl3z',
          title: 'C S 313E 54960',
          sub_title: 'Fa26 - ELEMENTS OF SOFTWARE DESIGN (54960/54965)',
          term_name: 'Fall 2026',
          visibility: 'general_public',
        },
      ],
    );

    expect(selected?.code).toBe('7574fsl3z');
    expect(simpleSyllabusDocumentUrls('utexas.simplesyllabus.com', selected!)).toEqual({
      htmlUrl: 'https://utexas.simplesyllabus.com/api2/doc-html/7574fsl3z/Fall-2026-C-S-313E-54960-Fa26-ELEMENTS-OF-SOFTWARE-DESIGN-%2854960-54965%29',
      sourceUrl: 'https://utexas.simplesyllabus.com/en-US/doc/7574fsl3z',
    });
    expect(inferSimpleSyllabusHost('utexas.instructure.com', 'UT Simple Syllabus'))
      .toBe('utexas.simplesyllabus.com');
    expect(inferSimpleSyllabusHost('utexas.instructure.com', 'Gradescope')).toBeNull();
  });

  it('only cleans exact known-bad initializer artifacts that are not in the current index', () => {
    const artifact = {
      id: 'bad-shell',
      sourceKey: 'utexas.instructure.com|course:1|initializer:embedded:abc',
      sha256: '447bb0e4248037c23e3db0fa89bf103ba8c4ecec8b75ef2248bad4d30b339f77',
    };
    expect(isKnownInvalidCanvasInitializerArtifact(artifact, new Set())).toBe(true);
    expect(isKnownInvalidCanvasInitializerArtifact(artifact, new Set(['bad-shell']))).toBe(false);
    expect(isKnownInvalidCanvasInitializerArtifact({
      ...artifact,
      sourceKey: 'manual-upload',
    }, new Set())).toBe(false);
  });
});
