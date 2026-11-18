# Canvas navigation and student storage

Stu uses the authenticated Canvas connection supplied by the browser extension. Canvas APIs are the primary interface; Cloudflare Browser Rendering is a bounded fallback for connected-host pages that Canvas does not expose cleanly through an API.

## What Stu can inspect

- course overviews, teachers, terms, navigation tabs, and native syllabus bodies
- assignments and their descriptions, rubrics, grading metadata, linked files, and useful Canvas URLs
- modules and module items, including pages, assignments, quizzes, files, and external resources
- pages, announcements, discussions, quizzes, course files, to-dos, calendar events, and assignment schedule entries
- course-wide search across assignments, modules, page bodies, discussions, announcements, files, quizzes, and tabs

Canvas navigation tools can run for several rounds in one turn. This lets Stu discover a course, locate a likely page or file, open it, inspect its contents, and then answer instead of stopping after the first API response.

## Syllabus discovery

The syllabus finder searches and ranks all common locations:

1. the course's native syllabus body and syllabus navigation tab
2. the course home/front page and other syllabus-named pages
3. modules and module items whose names resemble syllabus, course information, policies, or schedule
4. course files with syllabus-like names
5. external links exposed by the preceding locations

The response includes candidate confidence, source type, text when available, and a direct URL. A high-confidence textual syllabus is saved automatically as a text snapshot so it remains available in Memory & Storage.

## File inspection and storage

When a question depends on a Canvas file, Stu can download the file with the student's authenticated Canvas session, save it to R2, and provide supported documents or images to the OpenAI Responses API for inspection. Canvas credentials are never forwarded to an external host, including across redirects.

Storage policy:

- 100 MB of Canvas-managed storage per student
- 15 MB maximum for one downloaded resource
- SHA-256 content addressing and source-based upserts, so revisiting the same source updates rather than duplicates it
- stored metadata includes the course, purpose, original source URL, MIME type, size, and update time
- account deletion includes these R2 objects through the existing attachment cleanup path

Students manage saved syllabi, assignments, and course resources from **Memory & Storage** in the dashboard. They can download a stored copy, open the original source, or delete it. Memories are shown in the same area but remain a separate data type from files.

## Browser fallback boundaries

Browser Rendering only starts on the exact connected Canvas HTTPS origin. It receives only cookies valid for that Canvas host, extracts the main page text and links, and closes the browser at the end of the read. Stu is instructed to use it only after the Canvas API tools are insufficient. The fallback is read-only and does not submit assignments, take quizzes, send messages, or alter course state.

## API surface

- `GET /v1/storage` lists the authenticated student's Canvas-managed files and quota usage.
- `GET /v1/attachments/:id` downloads an owned stored file.
- `DELETE /v1/attachments/:id` deletes an owned stored file.

The storage endpoint requires the same authenticated student session as the rest of the dashboard API.
