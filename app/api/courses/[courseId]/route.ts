import { requireOwnerApi } from "@/lib/authz";
import { getCourseDetail } from "@/lib/repository";

export async function GET(_request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { courseId } = await params;
  const detail = await getCourseDetail(courseId);
  return detail ? Response.json(detail) : Response.json({ error: "课程不存在" }, { status: 404 });
}
