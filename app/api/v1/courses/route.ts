import { requireOwnerApi } from "@/lib/authz";
import { listCourseSettings } from "@/lib/repository";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const courses = await listCourseSettings();
  return Response.json({ courses, count: courses.length });
}
