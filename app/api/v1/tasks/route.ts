import { requireOwnerApi } from "@/lib/authz";
import { listTasks } from "@/lib/repository";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const courseId = params.get("courseId");
  const status = params.get("status");
  const includeCompleted = params.get("includeCompleted") === "true";
  const tasks = (await listTasks()).filter((task) =>
    (!courseId || task.courseId === courseId || task.courseCode === courseId) &&
    (!status || task.canvasStatus === status) &&
    (includeCompleted || task.localStatus !== "completed")
  );
  return Response.json({ tasks, count: tasks.length, generatedAt: new Date().toISOString() });
}
