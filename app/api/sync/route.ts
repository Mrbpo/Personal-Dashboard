import { listActiveCourses } from "@/lib/canvas";
import { requireOwnerApi } from "@/lib/authz";
import { listCourseSettings, listTasks, startSyncRun, upsertCourses } from "@/lib/repository";

export async function POST() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const courses = await listActiveCourses();
    await upsertCourses(courses);
    const enabledIds = new Set((await listCourseSettings()).filter((course) => course.enabled).map((course) => course.id));
    const nearestDue = new Map<string, number>();
    for (const task of await listTasks()) {
      if (!task.dueAt || task.localStatus !== "active" || task.urgency === "review" || ["completed", "locked", "possibly_superseded"].includes(task.canvasStatus)) continue;
      const due = new Date(task.dueAt).getTime();
      nearestDue.set(task.courseId, Math.min(nearestDue.get(task.courseId) ?? Number.POSITIVE_INFINITY, due));
    }
    const enabledCourses = courses
      .filter((course) => enabledIds.has(String(course.id)))
      .sort((a, b) => (nearestDue.get(String(a.id)) ?? Number.POSITIVE_INFINITY) - (nearestDue.get(String(b.id)) ?? Number.POSITIVE_INFINITY));
    const courseIds = enabledCourses.map((course) => String(course.id));
    const runId = crypto.randomUUID();
    await startSyncRun(runId, courseIds);
    return Response.json({
      runId,
      courses: enabledCourses.map((course) => ({
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
