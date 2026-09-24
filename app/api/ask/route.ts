import { getCurrentOwner } from "@/lib/authz";
import { searchArchiveForAnswer } from "@/lib/archive-search";
import { answerCourseQuestion } from "@/lib/course-qa";
import { askFailureKind, askFailureMessage, type AskStage } from "@/lib/ask-diagnostics";
import type { CourseSearchResult } from "@/lib/repository";

function publicSource(source: CourseSearchResult) {
  return {
    ref: source.ref, sourceId: source.sourceId, courseId: source.courseId, courseCode: source.courseCode,
    sourceType: source.sourceType, title: source.title, excerpt: source.excerpt,
    sourceUrl: source.sourceUrl, updatedAt: source.updatedAt,
    confirmedAnswer: Boolean(source.confirmedAnswer), unconfirmedDiscussion: Boolean(source.unconfirmedDiscussion),
  };
}

export async function POST(request: Request) {
  const started = performance.now();
  const owner = await getCurrentOwner();
  if (!owner) return Response.json({ error: "需要登录或有效 API Token" }, { status: 401 });
  const requestId = crypto.randomUUID();
  let stage: AskStage = 'request';
  try {
    const body = await request.json() as { question?: string; courseId?: string };
    const question = String(body.question || "").trim();
    if (question.length < 2) return Response.json({ error: "请输入课程问题" }, { status: 400 });
    if (question.length > 600) return Response.json({ error: "问题不能超过 600 字" }, { status: 400 });
    const summary = /总结|汇总|概览|概括|summari[sz]|summary|overview/i.test(question);
    stage = 'search';
    const { sources, inferredCourseId, courseSelection, timings } = await searchArchiveForAnswer(owner.userId, question, body.courseId, summary ? 100 : 12);
    if (courseSelection) {
      const subject = /数学|微积分|\bmath|\bcalculus/i.test(question) ? '数学' : /统计|\bstat/i.test(question) ? '统计' : '化学';
      const answer = courseSelection.length
        ? `符合“${subject}”的课程：${courseSelection.map((course) => course.code).join('、')}。请在上方选择对应课程或在问题中写出课程代码，再查询具体要求。`
        : '目前没有找到已启用的对应课程。请检查课程同步状态，或在上方选择课程后再查询。';
      return Response.json({ answer, needsClarification: true, followUps: [], citationRefs: [], aiAvailable: false, feedbackId: '', inferredCourseId: null, coverage: '未跨课程引用资料。', citations: [] }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const answerStarted = performance.now();
    stage = 'answer';
    const result = await answerCourseQuestion(question, sources);
    const answerMs = performance.now() - answerStarted;
    stage = 'response';
    const used = new Set(result.citationRefs);
    const citations = sources.filter((source) => used.has(source.ref)).map(publicSource);
    const serverTiming = [
      ['courses', timings.coursesMs], ['structured', timings.structuredMs], ['library', timings.libraryMs],
      ['embedding', timings.embeddingMs], ['ranking', timings.rankingMs], ['answer', answerMs], ['total', performance.now() - started],
    ].map(([name, value]) => `${name};dur=${Number(value).toFixed(1)}`).join(', ');
    return Response.json({ ...result, feedbackId: crypto.randomUUID(), inferredCourseId, coverage: `基于本地 ${sources.length} 条目录、帖子或文档正文${summary ? '（单次最多 100 条；长内容按相关片段读取）' : ''}；未读取未归档内容。`, citations }, { headers: { 'Server-Timing': serverTiming, 'X-Search-Candidates': String(timings.candidateCount), 'X-Search-Vector-Rows': String(timings.vectorRows), 'X-Search-Vector-Bytes': String(timings.vectorBytes), 'Cache-Control': 'no-store' } });
  } catch (error) {
    const kind = askFailureKind(error);
    console.error('[course-ask] request failed', { requestId, stage, kind, durationMs: Math.round(performance.now() - started) });
    return Response.json({ error: askFailureMessage(stage, kind) }, { status: 502, headers: {
      'X-Request-Id': requestId, 'X-Ask-Failure-Stage': stage, 'X-Ask-Failure-Kind': kind,
      'Server-Timing': `total;dur=${(performance.now() - started).toFixed(1)}`, 'Cache-Control': 'no-store',
    } });
  }
}
