import { requireOwnerApi } from "@/lib/authz";
import { answerCourseQuestion } from "@/lib/course-qa";
import { searchCourseContent } from "@/lib/repository";

function publicSource(source: Awaited<ReturnType<typeof searchCourseContent>>[number]) {
  return {
    ref: source.ref, sourceId: source.sourceId, courseId: source.courseId, courseCode: source.courseCode,
    sourceType: source.sourceType, title: source.title, excerpt: source.excerpt,
    sourceUrl: source.sourceUrl, updatedAt: source.updatedAt,
  };
}

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const body = await request.json() as { question?: string; courseId?: string };
    const question = String(body.question || "").trim();
    if (question.length < 2) return Response.json({ error: "请输入课程问题" }, { status: 400 });
    if (question.length > 600) return Response.json({ error: "问题不能超过 600 字" }, { status: 400 });
    const summary = /总结|汇总|概览|概括|summari[sz]|summary|overview/i.test(question);
    const sources = await searchCourseContent(question, body.courseId, summary ? 100 : 12);
    const result = await answerCourseQuestion(question, sources);
    const used = new Set(result.citationRefs);
    const citations = sources.filter((source) => used.has(source.ref)).map(publicSource);
    return Response.json({ ...result, coverage: `基于本地 ${sources.length} 条资料${summary ? '（单次最多 100 条；长帖使用前 6000 字）' : ''}；未读取未归档内容。`, citations: citations.length ? citations : sources.slice(0, 3).map(publicSource) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "COURSE_QUESTION_FAILED";
    return Response.json({ error: message.startsWith("OPENAI_") ? "AI 回答没有完整生成，请重新试一次" : "全站检索暂时不可用，请稍后重试" }, { status: 502 });
  }
}
