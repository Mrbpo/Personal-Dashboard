import { requireOwnerApi } from "@/lib/authz";
import { dashboardData, ensureDailyPlan } from "@/lib/repository";
import { hasOpenAI } from "@/lib/openai-analysis";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const date = new URL(request.url).searchParams.get("date") || new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  try {
    await ensureDailyPlan(date, hasOpenAI());
    return Response.json(await dashboardData(date));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "DASHBOARD_FAILED" }, { status: 503 });
  }
}
