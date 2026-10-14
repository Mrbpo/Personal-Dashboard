import { requireOwnerApi } from "@/lib/authz";
import { dashboardData, getSettings } from "@/lib/repository";
import { getCurrentOwner } from "@/lib/authz";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const owner = await getCurrentOwner();
    const settings = await getSettings(owner!.userId);
    const date = new URL(request.url).searchParams.get("date") || new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone });
    return Response.json({ ...await dashboardData(date, settings.timezone), settings }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "DASHBOARD_FAILED" }, { status: 503 });
  }
}
