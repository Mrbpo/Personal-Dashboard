import { getCourseSources } from "@/lib/canvas";
import { analyzeSource, analyzeSourceFile, hasOpenAI } from "@/lib/openai-analysis";
import { requireOwnerApi } from "@/lib/authz";
import {
  getStoredSource,
  hashSource,
  markCourseSynced,
  saveAssignment,
  rebuildCourseSummary,
  reconcileCourseSources,
  saveSource,
  touchSource,
  updateSyncCourse,
} from "@/lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { courseId } = await params;
  const searchParams = new URL(request.url).searchParams;
  const runId = searchParams.get("runId");
  const analysisLimit = searchParams.get("mode") === "automatic" ? 6 : 30;
  if (!runId) return Response.json({ error: "缺少 runId" }, { status: 400 });

  await updateSyncCourse(runId, courseId, "running");
  try {
    const { sources, assignments } = await getCourseSources(courseId);
    for (const assignment of assignments) await saveAssignment(courseId, assignment);

    let analyzed = 0;
    let attempted = 0;
    let unchanged = 0;
    let aiFailures = 0;
    const orderedSources = [...sources].sort((a, b) => {
      if (Boolean(a.dueAt) !== Boolean(b.dueAt)) return a.dueAt ? -1 : 1;
      if (a.dueAt && b.dueAt) return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
      return a.sourceType === "assignment" ? -1 : b.sourceType === "assignment" ? 1 : 0;
    });
    for (const source of orderedSources) {
      const hash = await hashSource(source);
      const stored = await getStoredSource(source.id);
      if (stored?.content_hash === hash && stored.extraction_version >= 5 && (stored.analysis_status === "complete" || !hasOpenAI())) {
        unchanged += 1;
        await touchSource(source.id);
        continue;
      }

      let analysis = null;
      const eligible = source.body.length >= 24 || Boolean(source.file);
      let analysisStatus = eligible ? (hasOpenAI() ? "pending" : "ai_unavailable") : "rule_only";
      if (eligible && hasOpenAI() && attempted < analysisLimit) {
        attempted += 1;
        try {
          analysis = source.file ? await analyzeSourceFile(source) : await analyzeSource(source);
          analysisStatus = "complete";
          analyzed += 1;
        } catch (error) {
          aiFailures += 1;
          const code = error instanceof Error ? error.message : "AI_ANALYSIS_FAILED";
          analysisStatus = code === "FILE_TOO_LARGE" ? "file_too_large" : code === "FILE_ANALYSIS_UNAVAILABLE" ? "unsupported_file" : "ai_failed";
        }
      }
      if (["externaltool", "externalurl"].includes(source.sourceType)) analysisStatus = "external_unreadable";
      await saveSource(source, analysis, hash, analysisStatus);
    }
    const missing = await reconcileCourseSources(courseId, sources.map((source) => source.id));
    await markCourseSynced(courseId);
    await rebuildCourseSummary(courseId);
    await updateSyncCourse(runId, courseId, "complete");
    return Response.json({ courseId, sourceCount: sources.length, analyzed, attempted, unchanged, aiFailures, missing });
  } catch (error) {
    const message = error instanceof Error ? error.message : "COURSE_SYNC_FAILED";
    await updateSyncCourse(runId, courseId, "failed", message);
    return Response.json({ error: message, courseId }, { status: 502 });
  }
}
