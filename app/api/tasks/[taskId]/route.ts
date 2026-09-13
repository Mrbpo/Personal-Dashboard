import { requireOwnerApi } from "@/lib/authz";
import { setTaskStatus } from "@/lib/repository";

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { taskId } = await params;
  const payload = await request.json() as { status?: string };
  if (!["active", "completed", "ignored"].includes(payload.status || "")) {
    return Response.json({ error: "无效状态" }, { status: 400 });
  }
  await setTaskStatus(taskId, payload.status as "active" | "completed" | "ignored");
  return Response.json({ taskId, status: payload.status });
}
