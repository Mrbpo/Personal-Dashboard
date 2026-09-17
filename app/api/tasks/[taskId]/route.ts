import { requireOwnerApi } from "@/lib/authz";
import { getTaskCanvasTarget, setTaskStatus } from "@/lib/repository";
import { setCanvasPlannerComplete } from "@/lib/canvas";

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { taskId } = await params;
  const payload = await request.json() as { status?: string; syncCanvas?: boolean };
  if (!["active", "completed", "ignored"].includes(payload.status || "")) {
    return Response.json({ error: "无效状态" }, { status: 400 });
  }
  let canvas = { supported: false, synced: false };
  if (payload.syncCanvas && payload.status !== "ignored") {
    const target = await getTaskCanvasTarget(taskId);
    if (!target) return Response.json({ error: "任务不存在" }, { status: 404 });
    try {
      canvas = await setCanvasPlannerComplete(target.source_type, target.source_id, payload.status === "completed");
    } catch (error) {
      const code = error instanceof Error ? error.message : "CANVAS_PLANNER_WRITE_FAILED";
      return Response.json({ error: code }, { status: 502 });
    }
  }
  await setTaskStatus(taskId, payload.status as "active" | "completed" | "ignored");
  return Response.json({ taskId, status: payload.status, canvas });
}
