import { getChatGPTUser } from "@/app/chatgpt-auth";
import { requireOwnerApi } from "@/lib/authz";
import { getSettings, saveSettings } from "@/lib/repository";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const user = await getChatGPTUser();
  return Response.json(await getSettings(user!.userId));
}

export async function PUT(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const user = await getChatGPTUser();
  const payload = await request.json() as { timezone?: string; dailyMinutes?: number };
  const timezone = payload.timezone?.trim() || "America/Toronto";
  const dailyMinutes = Math.max(30, Math.min(720, Number(payload.dailyMinutes) || 150));
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { return Response.json({ error: "无效时区" }, { status: 400 }); }
  await saveSettings(user!.userId, timezone, dailyMinutes);
  return Response.json({ timezone, dailyMinutes });
}
