import { requireOwnerApi } from "@/lib/authz";
import { getCourseDetail, setCourseEnabled } from "@/lib/repository";

export async function GET(_request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { courseId } = await params;
  const detail = await getCourseDetail(courseId);
  return detail ? Response.json(detail) : Response.json({ error: "课程不存在" }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { courseId } = await params;
  const body = await request.json().catch(() => null) as { enabled?: boolean } | null;
  if (typeof body?.enabled !== "boolean") return Response.json({ error: "enabled 必须为布尔值" }, { status: 400 });
  await setCourseEnabled(courseId, body.enabled);
  return Response.json({ courseId, enabled: body.enabled });
}
