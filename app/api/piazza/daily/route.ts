import { requireOwnerApi } from "@/lib/authz";
import { getPiazzaDailySummary, piazzaDate, piazzaTimezone } from "@/lib/piazza-digest";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const timezone = await piazzaTimezone();
  const date = new URL(request.url).searchParams.get("date") || piazzaDate(new Date(), timezone);
  try { return Response.json(await getPiazzaDailySummary(date, timezone)); }
  catch { return Response.json({ error: "日期无效或暂时无法生成摘要" }, { status: 400 }); }
}
