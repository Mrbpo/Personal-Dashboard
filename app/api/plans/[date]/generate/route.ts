import { getCurrentOwner, requireOwnerApi } from "@/lib/authz";
import { hasOpenAI } from "@/lib/openai-analysis";
import { getSettings, listTasks, saveDailyPlan } from "@/lib/repository";

export async function POST(_request: Request, { params }: { params: Promise<{ date: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "无效日期" }, { status: 400 });
  const owner = await getCurrentOwner();
  const settings = await getSettings(owner!.userId);
  const plan = await saveDailyPlan(date, await listTasks(), hasOpenAI(), settings.dailyMinutes);
  return Response.json({ date, plan, aiAvailable: hasOpenAI() });
}
