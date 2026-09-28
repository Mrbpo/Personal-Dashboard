import { searchArchiveForAnswer, explicitArchiveCourse, subjectArchiveCourses } from '../archive-search.ts';
import { answerCourseQuestion } from '../course-qa.ts';
import { relatedLibraryDocuments, searchLibrary } from '../library.ts';
import type { CourseSearchResult } from '../repository.ts';
import { kernel } from './service.ts';
import { evidenceLimitForQuestion, selectDocumentEvidence } from './evidence-selection.ts';
import { asksForCourseIdentity, asksForEventTiming } from '../search-vocabulary.ts';

type Course = { id: string; code: string; name: string; enabled: boolean };
type Citation = Pick<CourseSearchResult, 'ref' | 'sourceId' | 'courseId' | 'courseCode' | 'sourceType' | 'title' | 'excerpt' | 'sourceUrl' | 'updatedAt'>;
const deterministic = /截止|到期|due|deadline|考试时间|考试日期|日程|日历|event|任务|作业|assignment|quiz|测验|状态|取消|延期|什么时候|何时|课程|学期|\bcourse\b|\bterm\b|要求|实验|\blab\s*\d+\b|\btutorial\s*\d+\b|requirements?/i;
const stop = new Set(['what', 'when', 'which', 'where', 'how', 'the', 'and', 'for', 'with', '什么时候', '是什么', '有哪些', '怎么做', '课程', '作业', '任务', '截止', '日期', '时间', '我的']);

function terms(value: string) {
  const normalized = value.toLocaleLowerCase();
  const latin = normalized.match(/[a-z][a-z0-9_-]{2,}|\b\d{1,3}\b/g) || [];
  const chinese = (normalized.match(/[\u3400-\u9fff]+/g) || []).flatMap(word => word.length <= 2 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)));
  return [...new Set([...latin, ...chinese].filter(word => !stop.has(word)))];
}

function rank(question: string, title: string, body: string) {
  const words = terms(question);
  const heading = title.toLocaleLowerCase();
  const content = body.toLocaleLowerCase();
  const contains = (text: string, word: string) => /^\d+$/.test(word)
    ? new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`).test(text) : text.includes(word);
  return words.reduce((sum, word) => sum + (contains(heading, word) ? 4 : 0) + (contains(content, word) ? 1 : 0), 0);
}

function dueLabel(row: Record<string, unknown>) {
  if (row.due_precision === 'date' && row.due_date) return `${row.due_date}（仅日期）`;
  if (row.due_date && row.due_local_time && row.due_timezone) return `${row.due_date} ${row.due_local_time} ${row.due_timezone}`;
  if (row.due_at && row.due_precision !== 'date') return String(row.due_at);
  return row.due_original ? `待核实：${row.due_original}` : '未设置';
}

function upcoming(row: Record<string, unknown>) {
  const timestamp = Date.parse(String(row.due_at || row.due_date || ''));
  return Number.isFinite(timestamp) ? Math.abs(timestamp - Date.now()) : Number.POSITIVE_INFINITY;
}

function source(ref: string, input: Omit<CourseSearchResult, 'ref'>): CourseSearchResult {
  return { ...input, ref };
}

export async function askKernel(owner: string, question: string, requestedCourse = '', history: string[] = []) {
  const courses = (await kernel.listCourses()).filter(row => row.enabled) as Course[];
  const selected = requestedCourse ? courses.find(row => row.id === requestedCourse || row.code === requestedCourse) : null;
  if (requestedCourse && !selected) throw new Error('课程无效');
  const subject = subjectArchiveCourses(question, courses);
  const explicit = explicitArchiveCourse(question, courses);
  if (selected && explicit && selected.id !== explicit) {
    return { answer: `问题提到的课程与已选课程不同。请确认使用 ${selected.code} 还是 ${courses.find(row => row.id === explicit)?.code}。`, citations: [] as Citation[], inferredCourseId: null, coverage: '未跨课程读取资料。', needsClarification: true, aiAvailable: false };
  }
  if (subject && (subject.length !== 1 && !selected && !explicit || selected && !subject.some(row => row.id === selected.id))) {
    return { answer: subject.length ? `请先选定课程：${subject.map(row => row.code).join('、')}` : '没有找到对应的已启用课程。', citations: [] as Citation[], inferredCourseId: null, coverage: '未跨课程读取资料。', needsClarification: true, aiAvailable: false };
  }
  const courseId = selected?.id || explicit || subject?.[0]?.id || '';
  const courseCode = courses.find(row => row.id === courseId)?.code || '';
  const needFacts = deterministic.test(question) || asksForEventTiming(question);
  const needTasks = /截止|到期|due|deadline|任务|作业|assignment|quiz|测验|提交|状态|取消|延期|要求|实验|\blab\s*\d+\b|\btutorial\s*\d+\b|requirements?/i.test(question);
  const needsTimingStatus = /截止|到期|due|deadline|状态|取消|延期|什么时候|何时|\b(?:when|status|cancelled|date|time)\b/i.test(question);
  const structured: CourseSearchResult[] = [];
  let chosenTasks: Array<{ row: Record<string, unknown>; score: number }> = [];
  let chosenEvents: Array<{ row: Awaited<ReturnType<typeof kernel.listEvents>>[number]; score: number }> = [];
  if (needFacts) {
    const rows = needTasks ? await kernel.taskRows(courseId || undefined, true) as Record<string, unknown>[] : [];
    const matched = rows.map(row => ({ row, score: rank(question, String(row.title || ''), `${row.action || ''} ${JSON.stringify(row.requirements || [])}`) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || upcoming(a.row) - upcoming(b.row));
    chosenTasks = (matched.length ? matched : /任务|作业|截止|到期|接下来|最近|deadline|\bdue\b|assignment|\btask\b/i.test(question)
      ? rows.map(row => ({ row, score: 0 })).sort((a, b) => upcoming(a.row) - upcoming(b.row)) : []).slice(0, 6);
    const evidence = chosenTasks.length ? await kernel.canonicalEvidence([], chosenTasks.map(item => String(item.row.id)), []) : [];
    for (const { row } of chosenTasks) {
      const related = evidence.filter(item => item.task_id === row.id);
      const proof = related.slice(0, 4).map(item => `${item.attribute}：${item.source} ${item.original_excerpt || ''}`.slice(0, 350)).join('\n');
      structured.push(source('', {
        sourceId: String(row.id), courseId: String(row.course_id), courseCode: String(row.course_code), sourceType: 'kernel-task',
        title: String(row.title), excerpt: String(row.evidence_excerpt || row.action || '').slice(0, 300),
        body: `当前内核任务：${row.title}\n行动：${row.action || ''}\n要求：${(Array.isArray(row.requirements) ? row.requirements : []).join('；')}${needsTimingStatus ? `\n截止：${dueLabel(row)}\n状态：${row.local_status}；Canvas：${row.canvas_status}\n取消：${row.cancelled_at ? '是' : '否'}；来源消失：${row.source_missing ? '是，需核查' : '否'}` : ''}\n已采纳证据：${proof || '暂无可展示片段'}`,
        sourceUrl: typeof row.source_url === 'string' ? row.source_url : null, updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      }));
    }
    if (asksForEventTiming(question)) {
      const start = new Date(Date.now() - 365 * 86400000).toISOString();
      const end = new Date(Date.now() + 365 * 86400000).toISOString();
      const events = await kernel.listEvents(start, end);
      chosenEvents = events.filter(row => !courseId || `${row.title} ${row.description}`.includes(courseCode))
        .map(row => ({ row, score: rank(question, row.title, row.description) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
      for (const event of chosenEvents) {
        structured.push(source('', { sourceId: event.row.id, courseId: 'schedule', courseCode: '个人日程', sourceType: 'kernel-event', title: event.row.title,
          excerpt: event.row.description.slice(0, 300), body: `当前内核事件：${event.row.title}\n开始：${event.row.startAt}\n结束：${event.row.endAt}\n全天：${event.row.allDay ? '是' : '否'}\n${event.row.description}`,
          sourceUrl: null, updatedAt: null }));
      }
    }
    if (/课程|学期|\bcourse\b|\bterm\b/i.test(question)) for (const course of courseId ? courses.filter(row => row.id === courseId) : courses) {
      structured.push(source('', { sourceId: course.id, courseId: course.id, courseCode: course.code, sourceType: 'kernel-course',
        title: `${course.code} · ${course.name}`, excerpt: course.name, body: `当前内核课程：${course.code} ${course.name}`, sourceUrl: null, updatedAt: null }));
    }
  }
  const directFacts = !/要求|内容|解释|分析|总结|概览|大纲|讲什么|为什么|怎么|如何|syllabus|outline|what to do|how to/i.test(question);
  const dueQuestion = /截止|到期|due|deadline/i.test(question);
  const statusQuestion = /状态|完成|取消|status|completed|cancelled/i.test(question);
  const courseQuestion = asksForCourseIdentity(question) && !needTasks && !asksForEventTiming(question);
  const scheduleQuestion = asksForEventTiming(question) && !needTasks;
  if (directFacts && (dueQuestion || statusQuestion || courseQuestion || scheduleQuestion)) {
    const facts = structured.map((item, index) => ({ ...item, ref: `S${index + 1}` }));
    const picked = (items: typeof facts) => items.map(({ ref, sourceId, courseId, courseCode, sourceType, title, excerpt, sourceUrl, updatedAt }) =>
      ({ ref, sourceId, courseId, courseCode, sourceType, title, excerpt, sourceUrl, updatedAt }));
    let used: typeof facts = [], lines: string[] = [], ambiguous = false;
    if (dueQuestion || statusQuestion) {
      const multiple = /哪些|所有|全部|列表|列出|接下来|最近|分别|each|all/i.test(question);
      ambiguous = !multiple && chosenTasks.length > 1 && chosenTasks[0].score === chosenTasks[1].score;
      if (ambiguous) lines = [`找到多个可能的任务：${chosenTasks.slice(0, 3).map(item => item.row.title).join('、')}。请写明任务名称。`];
      else {
        used = facts.filter(item => item.sourceType === 'kernel-task').slice(0, multiple ? 6 : 1);
        lines = used.map(item => {
          const row = chosenTasks.find(candidate => String(candidate.row.id) === item.sourceId)!.row;
          const state = row.cancelled_at ? '已取消' : row.source_missing ? '来源已消失，待核查；任务未自动取消' : String(row.local_status);
          return `${row.title}：${dueQuestion ? `截止 ${dueLabel(row)}` : `状态 ${state}`}${row.cancelled_at && dueQuestion ? '；已取消' : ''} [${item.ref}]`;
        });
      }
    } else if (scheduleQuestion) {
      const multiple = /哪些|所有|全部|列表|列出|接下来|最近|分别|each|all/i.test(question);
      ambiguous = !multiple && chosenEvents.length > 1 && chosenEvents[0].score === chosenEvents[1].score;
      if (ambiguous) lines = [`找到多个可能的事件：${chosenEvents.slice(0, 3).map(item => item.row.title).join('、')}。请写明事件名称。`];
      else {
        used = facts.filter(item => item.sourceType === 'kernel-event').slice(0, multiple ? 4 : 1);
        lines = used.map(item => { const row = chosenEvents.find(candidate => candidate.row.id === item.sourceId)!.row;
          return `${row.title}：${row.allDay ? `${row.startAt.slice(0, 10)}（全天）` : `${row.startAt} 至 ${row.endAt}`} [${item.ref}]`; });
      }
    } else if (courseQuestion) {
      used = facts.filter(item => item.sourceType === 'kernel-course');
      lines = used.map(item => `${item.title} [${item.ref}]`);
    }
    return { answer: lines.join('\n') || '内核中没有找到可确认的信息。', citations: picked(used), inferredCourseId: courseId || null,
      coverage: `直接读取 PostgreSQL 内核事实 ${used.length} 条。`, needsClarification: ambiguous || !used.length, aiAvailable: false };
  }
  const archiveQuery = history.length && question.length < 25 ? `${history.at(-1)} ${question}` : question;
  const archive = await searchArchiveForAnswer(owner, archiveQuery, courseId, /总结|汇总|概览|summary/i.test(question) ? 40 : 12);
  if (archive.courseSelection && !courseId) {
    return { answer: `请先选定课程：${archive.courseSelection.map(row => row.code).join('、')}`, citations: [] as Citation[], inferredCourseId: null, coverage: '未跨课程读取资料。', needsClarification: true, aiAvailable: false };
  }
  // Legacy Canvas task and calendar rows are excluded: their canonical versions live in PostgreSQL.
  const textSources = archive.sources.filter(item => !['assignment', 'quiz', 'schedule'].includes(item.sourceType) && (!courseId || item.courseId === courseId));
  const firstDocuments = [...new Map(textSources.filter(item => item.sourceType === 'document').map(item => [item.sourceId, item])).values()].slice(0, 4);
  const focusedSources: CourseSearchResult[] = [];
  const focusLimit = evidenceLimitForQuestion(question, structured.length ? 10 : 14);
  for (const item of firstDocuments.slice(0, 2)) {
    const name = item.title.split(' · ')[0];
    const stem = name.replace(/\.[a-z0-9]{1,8}$/i, '');
    const named = stem.length >= 8 && question.toLocaleLowerCase().includes(stem.toLocaleLowerCase());
    // A selected course with one matching document is a useful scope even when
    // the student did not type the entire PDF or syllabus filename.
    if (!named && (!courseId || firstDocuments.length !== 1)) continue;
    const candidates = await searchLibrary(owner, question, item.courseId, true,
      { documentId: item.sourceId, limit: 80, embeddingTimeoutMs: 2500 });
    if (candidates.length <= 12) continue;
    const selectedChunks = await selectDocumentEvidence(question, candidates, focusLimit);
    focusedSources.push(...selectedChunks.map(hit => source('', { sourceId: hit.document_id, courseId: hit.course_id,
      courseCode: item.courseCode, sourceType: 'document', title: `${hit.name} · ${hit.locator}`,
      excerpt: hit.body.slice(0, 300), body: hit.body, sourceUrl: item.sourceUrl, updatedAt: item.updatedAt })));
  }
  const related = firstDocuments.length ? await relatedLibraryDocuments(owner, question,
    firstDocuments.map(item => ({ documentId: item.sourceId, courseId: item.courseId, body: item.body, title: item.title.split(' · ')[0] })), 6) : [];
  const secondHop = related.length ? await relatedLibraryDocuments(owner, question,
    related.slice(0, 4).map(hit => ({ documentId: hit.document_id, courseId: hit.course_id, body: hit.body, title: hit.name })), 4) : [];
  const linked = [...related, ...secondHop].filter((hit, index, all) =>
    !textSources.some(item => item.sourceId === hit.document_id) && all.findIndex(item => item.document_id === hit.document_id) === index);
  const relatedSources = linked.map(hit => source('', {
    sourceId: hit.document_id, courseId: hit.course_id, courseCode: courses.find(row => row.id === hit.course_id)?.code || hit.course_id,
    sourceType: 'document', title: `${hit.name} · ${hit.locator}`, excerpt: hit.body.slice(0, 300), body: hit.body,
    sourceUrl: `/api/library/${hit.document_id}`, updatedAt: null,
  }));
  const combined = focusedSources.length
    ? [...structured.slice(0, 4), ...focusedSources.slice(0, focusLimit), ...textSources.slice(0, 4), ...relatedSources.slice(0, 3)]
    : [...structured.slice(0, 6), ...textSources.slice(0, structured.length ? 6 : 8), ...relatedSources.slice(0, structured.length ? 6 : 10)];
  const sources = combined.filter((item, index, all) => all.findIndex(other => other.sourceId === item.sourceId && other.body === item.body) === index)
    .slice(0, Math.max(18, Math.min(44, focusLimit + 4))).map((item, index) => ({ ...item, ref: `S${index + 1}` }));
  const answer = await answerCourseQuestion(question, sources, { kernelMode: true, history });
  const cited = new Set(answer.citationRefs);
  return { ...answer, citations: sources.filter(item => cited.has(item.ref)).map(({ ref, sourceId, courseId, courseCode, sourceType, title, excerpt, sourceUrl, updatedAt }) => ({ ref, sourceId, courseId, courseCode, sourceType, title, excerpt, sourceUrl, updatedAt })),
    inferredCourseId: courseId || archive.inferredCourseId, coverage: `内核事实 ${structured.length} 条；已归档原文 ${textSources.length + relatedSources.length + focusedSources.length} 条。未读取未归档内容。` };
}
