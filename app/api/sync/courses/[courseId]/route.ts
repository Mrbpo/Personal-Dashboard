import { getCourseSources } from "@/lib/canvas";
import { analyzeSource, analyzeSourceFile, hasOpenAI } from "@/lib/openai-analysis";
import { requireOwnerApi } from "@/lib/authz";
import {
  getStoredSource,
  hashSource,
  markCourseSynced,
  saveAssignment,
  saveCourseSummary,
  saveSource,
  touchSource,
  updateSyncCourse,
} from "@/lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { courseId } = await params;
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) return Response.json({ error: "缺少 runId" }, { status: 400 });

  await updateSyncCourse(runId, courseId, "running");
  try {
    const { sources, assignments } = await getCourseSources(courseId);
    for (const assignment of assignments) await saveAssignment(courseId, assignment);

    let analyzed = 0;
    let unchanged = 0;
    let aiFailures = 0;
    const summaryLines: string[] = [];
    for (const source of sources) {
      const hash = await hashSource(source);
      const stored = await getStoredSource(source.id);
      if (stored?.content_hash === hash) {
        unchanged += 1;
        await touchSource(source.id);
        continue;
      }

      let analysis = null;
      const eligible = source.body.length >= 24 || Boolean(source.file);
      if (eligible && hasOpenAI() && analyzed < 30) {
        try {
          analysis = source.file ? await analyzeSourceFile(source) : await analyzeSource(source);
          analyzed += 1;
          if (analysis.summary) summaryLines.push(analysis.summary);
        } catch {
          aiFailures += 1;
        }
      }
      await saveSource(source, analysis, hash);
    }
    await markCourseSynced(courseId);
    await saveCourseSummary(
      courseId,
      summaryLines.slice(0, 6).join(" ") || "已同步课程结构和确定的截止任务；暂无可用的 AI 摘要。",
      summaryLines.slice(0, 4),
      aiFailures ? ["部分内容暂时无法完成 AI 分析，请查看来源。"] : [],
      hasOpenAI() && analyzed > 0,
    );
    await updateSyncCourse(runId, courseId, "complete");
    return Response.json({ courseId, sourceCount: sources.length, analyzed, unchanged, aiFailures });
  } catch (error) {
    const message = error instanceof Error ? error.message : "COURSE_SYNC_FAILED";
    await updateSyncCourse(runId, courseId, "failed", message);
    return Response.json({ error: message, courseId }, { status: 502 });
  }
}
