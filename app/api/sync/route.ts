import { listActiveCourses } from "@/lib/canvas";
import { requireOwnerApi } from "@/lib/authz";
import { startSyncRun, upsertCourses } from "@/lib/repository";

export async function POST() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const courses = await listActiveCourses();
    await upsertCourses(courses);
    const courseIds = courses.map((course) => String(course.id));
    const runId = crypto.randomUUID();
    await startSyncRun(runId, courseIds);
    return Response.json({
      runId,
      courses: courses.map((course) => ({
        id: String(course.id),
        code: course.course_code || course.name || String(course.id),
        name: course.name || course.course_code || "未命名课程",
      })),
    }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SYNC_START_FAILED";
    const status = code === "CANVAS_TOKEN_NOT_CONFIGURED" ? 503 : code === "CANVAS_AUTH_FAILED" ? 401 : 502;
    return Response.json({ error: code }, { status });
  }
}
