import { requireOwnerApi } from "@/lib/authz";
import { dashboardData, ensureDailyPlan, getSettings } from "@/lib/repository";
import { hasOpenAI } from "@/lib/openai-analysis";
import { getCurrentOwner } from "@/lib/authz";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const owner = await getCurrentOwner();
    const settings = await getSettings(owner!.userId);
    const date = new URL(request.url).searchParams.get("date") || new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone });
    await ensureDailyPlan(date, hasOpenAI(), settings.dailyMinutes);
    return Response.json({ ...await dashboardData(date), settings });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "DASHBOARD_FAILED" }, { status: 503 });
  }
}
