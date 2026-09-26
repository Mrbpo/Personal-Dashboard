import { requireOwnerApi } from "@/lib/authz";
import { getTaskCanvasTarget, setTaskStatus } from "@/lib/repository";

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { taskId } = await params;
  const payload = await request.json() as { status?: string; syncCanvas?: boolean };
  if (!["active", "completed", "ignored"].includes(payload.status || "")) {
    return Response.json({ error: "无效状态" }, { status: 400 });
  }
  const target=await getTaskCanvasTarget(taskId);
  if(!target)return Response.json({error:'任务不存在'},{status:404});
  const supported=['announcement','assignment','discussion','quiz','page'].includes(target.source_type)
    && /^\d+$/.test(target.source_id);
  const queued=Boolean(payload.syncCanvas && payload.status !== 'ignored' && supported);
  await setTaskStatus(taskId,payload.status as "active" | "completed" | "ignored",queued);
  return Response.json({ taskId, status: payload.status, canvas: {supported,synced:false,queued} });
}
