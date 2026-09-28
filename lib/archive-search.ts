import { searchLibrary } from './library.ts';
import { listCourseSettings, searchCourseContent, type CourseSearchResult } from './repository.ts';
import { asksForSyllabus, asksOnlyForPiazza } from './search-vocabulary.ts';

type LibraryHit = Awaited<ReturnType<typeof searchLibrary>>[number];
type CourseOption = { id: string; code: string; name: string; enabled: boolean };
const syllabusTitle = /syllabus|course\s*outline|课程大纲|教学大纲/i;

function subjectCourse(course: CourseOption, subject: 'math' | 'stats' | 'chemistry') {
  const code = compact(course.code);
  const name = course.name.toLocaleLowerCase();
  if (subject === 'math') return /^MAT[A-Z]?\d/.test(code) || /\b(?:math|mathematics|calculus|algebra|geometry)\b/i.test(name) && !/\bstatistic/i.test(name);
  if (subject === 'stats') return /^STA[A-Z]?\d/.test(code) || /\bstatistic/i.test(name);
  return /^CHM[A-Z]?\d/.test(code) || /\bchemistry\b/i.test(name);
}

export function subjectArchiveCourses(question: string, courses: CourseOption[]): CourseOption[] | null {
  const subjects: Array<'math' | 'stats' | 'chemistry'> = [];
  // A mention of mathematical notation inside another selected course is not
  // a request to switch to a mathematics course.
  if (/数学|微积分|\bmath(?:ematics)?\b(?!\s+(?:notation|symbol|formula|expression|operator))|\bcalculus\b/i.test(question)) subjects.push('math');
  if (/统计|\bstat(?:s|istics?)?\b/i.test(question)) subjects.push('stats');
  if (/化学|\bchem(?:istry)?\b/i.test(question)) subjects.push('chemistry');
  // A comparison mentioning two subjects must not silently select either one.
  return subjects.length === 1 ? courses.filter((course) => course.enabled && subjectCourse(course, subjects[0])) : null;
}

function compact(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9\u3400-\u9fff]/g, '');
}

function activityMarker(value: string) {
  const match = compact(value).match(/(TUTORIAL|TUT|ASSIGNMENT|ASSIGN|HOMEWORK|HW|QUIZ|LAB)(\d{1,3})/);
  if (!match) return '';
  const kind = ({ TUTORIAL: 'TUT', TUT: 'TUT', ASSIGNMENT: 'ASSIGN', ASSIGN: 'ASSIGN', HOMEWORK: 'HW' } as Record<string, string>)[match[1]] || match[1];
  return `${kind}${match[2]}`;
}

export function explicitArchiveCourse(question: string, courses: CourseOption[]) {
  const query = compact(question);
  const exact = courses.find((course) => {
    const code = compact(course.code);
    const base = course.code.toUpperCase().replace(/\s/g, '').match(/[A-Z]{2,}\d+/)?.[0] || '';
    return course.enabled && Boolean(code && query.includes(code) || base.length >= 5 && query.includes(base));
  })?.id;
  if (exact) return exact;
  const semantic = subjectArchiveCourses(question, courses);
  return semantic?.length === 1 ? semantic[0].id : '';
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

export function inferActivityCourse(question: string, library: LibraryHit[]) {
  const requested = activityMarker(question);
  if (!requested) return '';
  const scores = new Map<string, number>();
  for (const hit of library) if (activityMarker(hit.name) === requested) scores.set(hit.course_id, (scores.get(hit.course_id) || 0) + hit.score);
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  return ranked[0] && (ranked.length === 1 || ranked[0][1] - ranked[1][1] >= 1.5) ? ranked[0][0] : '';
}

function normalizeName(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function mergeArchiveSources(structured: CourseSearchResult[], library: LibraryHit[], courses: CourseOption[], limit: number) {
  const codes = new Map(courses.map((course) => [course.id, course.code]));
  const documentKeys = new Set(library.map((hit) => `${hit.course_id}\0${normalizeName(hit.name)}`));
  const perDocument = new Map<string, number>();
  const documents: CourseSearchResult[] = library.filter((hit) => {
    const count = perDocument.get(hit.document_id) || 0;
    perDocument.set(hit.document_id, count + 1);
    return limit > 20 || count < 2;
  }).map((hit) => ({
    ref: '', sourceId: hit.document_id, courseId: hit.course_id,
    courseCode: codes.get(hit.course_id) || hit.course_id, sourceType: 'document',
    title: `${hit.name} · ${hit.locator}`, excerpt: hit.body.slice(0, 1400), body: hit.body,
    sourceUrl: `/api/library/${hit.document_id}`, updatedAt: null,
  }));
  const directoryWithoutParsedDuplicate = structured.filter((source) => !(source.sourceType === 'file' && documentKeys.has(`${source.courseId}\0${normalizeName(source.title)}`)));
  const confirmed = directoryWithoutParsedDuplicate.filter((source) => source.sourceType === 'piazza' && source.confirmedAnswer);
  const canvas = directoryWithoutParsedDuplicate.filter((source) => ['assignment', 'quiz', 'page', 'module', 'discussion', 'syllabus'].includes(source.sourceType));
  const other = directoryWithoutParsedDuplicate.filter((source) => !confirmed.includes(source) && !canvas.includes(source));
  const groups = [documents, confirmed, canvas, other];
  const selected: CourseSearchResult[] = [];
  for (let index = 0; selected.length < limit && groups.some((group) => group.length > index); index++) {
    for (const group of groups) if (group[index] && selected.length < limit) selected.push(group[index]);
  }
  return selected.map((source, index) => ({ ...source, ref: `S${index + 1}` }));
}

export function preferStrongDocumentMatches(question: string, structured: CourseSearchResult[], library: LibraryHit[]) {
  const summary = /总结|汇总|概览|概括|summari[sz]|summary|overview/i.test(question);
  const wantsSyllabus = asksForSyllabus(question);
  const strong = library.filter((hit) => hit.score >= 3);
  const requestedMarker = activityMarker(question);
  const inferredMarker = requestedMarker || (/\btut\b/i.test(question) ? activityMarker(strong[0]?.name || '') : '');
  const focused = inferredMarker ? library.filter((hit) => activityMarker(hit.name) === inferredMarker) : strong;
  if (summary || !focused.length) return { structured, library };
  const relevant = structured.filter((source) => {
    if (wantsSyllabus && (source.sourceType === 'syllabus' || syllabusTitle.test(source.title))) return true;
    if (inferredMarker && activityMarker(source.title) && activityMarker(source.title) !== inferredMarker) return false;
    if (source.sourceType === 'piazza') return true;
    if (['assignment', 'quiz', 'page', 'module', 'discussion'].includes(source.sourceType)) return true;
    if (source.sourceType === 'announcement') return /最新|更改|变动|公告|recent|change|announcement/i.test(question);
    return false;
  });
  const selectedLibrary = focused.slice(0, 4);
  if (wantsSyllabus) for (const hit of library) {
    if (syllabusTitle.test(`${hit.name} ${hit.folder_path || ''}`) && !selectedLibrary.some((selected) => selected.id === hit.id)) selectedLibrary.push(hit);
    if (selectedLibrary.length >= 6) break;
  }
  return { structured: relevant.slice(0, 8), library: selectedLibrary };
}

export async function searchArchiveForAnswer(owner: string, question: string, requestedCourse = '', limit = 12) {
  const started = performance.now();
  const timings = { coursesMs: 0, structuredMs: 0, libraryMs: 0, embeddingMs: 0, rankingMs: 0, totalMs: 0, candidateCount: 0, vectorRows: 0, vectorBytes: 0 };
  const recordLibrary = (detail: { embeddingMs:number; candidateCount:number; vectorRows:number; vectorBytes:number }) => {
    timings.embeddingMs += detail.embeddingMs;
    timings.candidateCount += detail.candidateCount;
    timings.vectorRows += detail.vectorRows;
    timings.vectorBytes += detail.vectorBytes;
  };
  const courseStarted = performance.now();
  const courses = (await listCourseSettings()).filter((course) => course.enabled);
  timings.coursesMs = performance.now() - courseStarted;
  let scope = requestedCourse || explicitArchiveCourse(question, courses);
  const subjectCourses = subjectArchiveCourses(question, courses);
  // A selected course or a code in the question must not override a conflicting subject.
  const courseSelection = subjectCourses && (!scope ? subjectCourses.length !== 1 : !subjectCourses.some((course) => course.id === scope))
    ? subjectCourses : null;
  if (!scope && subjectCourses?.length === 1) scope = subjectCourses[0].id;
  if (courseSelection) {
    timings.totalMs = performance.now() - started;
    return { sources: [] as CourseSearchResult[], inferredCourseId: null, courseSelection, timings };
  }
  const piazzaOnly = asksOnlyForPiazza(question);
  const [structuredResults, libraryResults] = await Promise.all([
    (async () => { const at = performance.now(); const result = await searchCourseContent(question, scope || undefined, scope ? limit : Math.max(limit * 3, 24)); timings.structuredMs += performance.now() - at; return result; })(),
    (async () => { const at = performance.now(); const result = piazzaOnly ? [] : await searchLibrary(owner, question, scope, false, { limit: 30, onTiming: recordLibrary }); timings.libraryMs += performance.now() - at; return result; })(),
  ]);
  let structured = structuredResults, library = libraryResults;
  if (!scope) {
    const genericLab = /实验|\blab(?:oratory)?\b/i.test(question) && !activityMarker(question);
    const competingCourses = new Set([...structured.map((item) => item.courseId), ...library.map((item) => item.course_id)].filter((id) => id && id !== 'schedule'));
    if (!genericLab || competingCourses.size <= 1) scope = inferActivityCourse(question, library) || inferArchiveCourse(structured, library);
    if (scope) {
      structured = structured.filter((item) => item.courseId === scope);
      library = library.filter((item) => item.course_id === scope);
    }
  }
  if (!piazzaOnly && !library.some((hit) => hit.score >= 2) && !structured.some((source) => source.confirmedAnswer || ['assignment', 'page'].includes(source.sourceType))) {
    const at = performance.now();
    library = await searchLibrary(owner, question, scope, true, { limit: 8, embeddingTimeoutMs: 2500, onTiming: recordLibrary });
    timings.libraryMs += performance.now() - at;
  }
  if (scope && asksForSyllabus(question) && !piazzaOnly) {
    const [syllabusSources, syllabusDocuments] = await Promise.all([
      (async () => { const at = performance.now(); const result = await searchCourseContent('syllabus course outline', scope, 8); timings.structuredMs += performance.now() - at; return result; })(),
      (async () => { const at = performance.now(); const result = await searchLibrary(owner, 'syllabus course outline', scope, false, { limit: 8, onTiming: recordLibrary }); timings.libraryMs += performance.now() - at; return result; })(),
    ]);
    const matchingSources = syllabusSources.filter((source) => source.sourceType === 'syllabus' || syllabusTitle.test(source.title));
    const matchingDocuments = syllabusDocuments.filter((hit) => syllabusTitle.test(`${hit.name} ${hit.folder_path || ''}`));
    structured = [...matchingSources, ...structured].filter((source, index, all) => all.findIndex((candidate) => candidate.sourceId === source.sourceId) === index);
    library = [...library, ...matchingDocuments].filter((hit, index, all) => all.findIndex((candidate) => candidate.id === hit.id) === index);
  }
  const rankingStarted = performance.now();
  ({ structured, library } = preferStrongDocumentMatches(question, structured, library));
  const sources = mergeArchiveSources(structured, library, courses, limit);
  timings.rankingMs = performance.now() - rankingStarted;
  timings.totalMs = performance.now() - started;
  return { sources, inferredCourseId: scope || null, courseSelection: null, timings };
}
