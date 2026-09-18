import { searchLibrary } from './library.ts';
import { listCourseSettings, searchCourseContent, type CourseSearchResult } from './repository.ts';

type LibraryHit = Awaited<ReturnType<typeof searchLibrary>>[number];
type CourseOption = { id: string; code: string; name: string; enabled: boolean };

function compact(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9\u3400-\u9fff]/g, '');
}

export function explicitArchiveCourse(question: string, courses: CourseOption[]) {
  const query = compact(question);
  return courses.find((course) => {
    const code = compact(course.code);
    const base = course.code.toUpperCase().replace(/\s/g, '').match(/[A-Z]{2,}\d+/)?.[0] || '';
    return course.enabled && Boolean(code && query.includes(code) || base.length >= 5 && query.includes(base));
  })?.id || '';
}

export function inferArchiveCourse(structured: CourseSearchResult[], library: LibraryHit[]) {
  const usable = structured.filter((item) => item.courseId && item.courseId !== 'schedule');
  if (usable.length >= 2 && usable[0].courseId === usable[1].courseId) return usable[0].courseId;
  const counts = new Map<string, number>();
  usable.slice(0, 5).forEach((item, index) => counts.set(item.courseId, (counts.get(item.courseId) || 0) + 6 - index));
  library.slice(0, 5).forEach((item, index) => counts.set(item.course_id, (counts.get(item.course_id) || 0) + 4 - Math.min(index, 3)));
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked[0] && ranked[0][1] >= 6 && ranked[0][1] - (ranked[1]?.[1] || 0) >= 3 ? ranked[0][0] : '';
}

function normalizeName(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function mergeArchiveSources(structured: CourseSearchResult[], library: LibraryHit[], courses: CourseOption[], limit: number) {
  const codes = new Map(courses.map((course) => [course.id, course.code]));
  const documentKeys = new Set(library.map((hit) => `${hit.course_id}\0${normalizeName(hit.name)}`));
  const documents: CourseSearchResult[] = library.map((hit) => ({
    ref: '', sourceId: hit.document_id, courseId: hit.course_id,
    courseCode: codes.get(hit.course_id) || hit.course_id, sourceType: 'document',
    title: `${hit.name} · ${hit.locator}`, excerpt: hit.body.slice(0, 1400), body: hit.body,
    sourceUrl: `/api/library/${hit.document_id}`, updatedAt: null,
  }));
  const directoryWithoutParsedDuplicate = structured.filter((source) => !(source.sourceType === 'file' && documentKeys.has(`${source.courseId}\0${normalizeName(source.title)}`)));
  return [...documents, ...directoryWithoutParsedDuplicate].slice(0, limit).map((source, index) => ({ ...source, ref: `S${index + 1}` }));
}

export async function searchArchiveForAnswer(owner: string, question: string, requestedCourse = '', limit = 12) {
  const courses = (await listCourseSettings()).filter((course) => course.enabled);
  let scope = requestedCourse || explicitArchiveCourse(question, courses);
  const piazzaOnly = /piazza/i.test(question);
  let [structured, library] = await Promise.all([
    searchCourseContent(question, scope || undefined, limit),
    piazzaOnly ? Promise.resolve([]) : searchLibrary(owner, question, scope, true),
  ]);
  if (!scope) {
    scope = inferArchiveCourse(structured, library);
    if (scope) [structured, library] = await Promise.all([
      searchCourseContent(question, scope, limit),
      piazzaOnly ? Promise.resolve([]) : searchLibrary(owner, question, scope, true),
    ]);
  }
  return { sources: mergeArchiveSources(structured, library, courses, limit), inferredCourseId: scope || null };
}
