import { requireOwnerApi } from "@/lib/authz";
import { listScheduleEvents } from "@/lib/repository";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) return Response.json({ error: "缺少日历范围" }, { status: 400 });
  return Response.json({ events: await listScheduleEvents(start, end) });
}
