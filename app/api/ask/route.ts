import { getCurrentOwner } from "@/lib/authz";
import { searchArchiveForAnswer } from "@/lib/archive-search";
import { answerCourseQuestion } from "@/lib/course-qa";
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
  try {
    const body = await request.json() as { question?: string; courseId?: string };
    const question = String(body.question || "").trim();
    if (question.length < 2) return Response.json({ error: "请输入课程问题" }, { status: 400 });
    if (question.length > 600) return Response.json({ error: "问题不能超过 600 字" }, { status: 400 });
    const summary = /总结|汇总|概览|概括|summari[sz]|summary|overview/i.test(question);
    const { sources, inferredCourseId, timings } = await searchArchiveForAnswer(owner.userId, question, body.courseId, summary ? 100 : 12);
    const answerStarted = performance.now();
    const result = await answerCourseQuestion(question, sources);
    const answerMs = performance.now() - answerStarted;
    const used = new Set(result.citationRefs);
    const citations = sources.filter((source) => used.has(source.ref)).map(publicSource);
    const serverTiming = [
      ['courses', timings.coursesMs], ['structured', timings.structuredMs], ['library', timings.libraryMs],
      ['embedding', timings.embeddingMs], ['ranking', timings.rankingMs], ['answer', answerMs], ['total', performance.now() - started],
    ].map(([name, value]) => `${name};dur=${Number(value).toFixed(1)}`).join(', ');
    return Response.json({ ...result, feedbackId: crypto.randomUUID(), inferredCourseId, coverage: `基于本地 ${sources.length} 条目录、帖子或文档正文${summary ? '（单次最多 100 条；长内容按相关片段读取）' : ''}；未读取未归档内容。`, citations }, { headers: { 'Server-Timing': serverTiming, 'X-Search-Candidates': String(timings.candidateCount), 'X-Search-Vector-Rows': String(timings.vectorRows), 'X-Search-Vector-Bytes': String(timings.vectorBytes), 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "COURSE_QUESTION_FAILED";
    return Response.json({ error: message.startsWith("OPENAI_") ? "AI 回答没有完整生成，请重新试一次" : "全站检索暂时不可用，请稍后重试" }, { status: 502 });
  }
}
