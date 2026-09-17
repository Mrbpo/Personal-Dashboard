import { getCurrentOwner, requireOwnerApi } from "@/lib/authz";
import { getSettings, saveSettings } from "@/lib/repository";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const user = await getCurrentOwner();
  return Response.json(await getSettings(user!.userId));
}

export async function PUT(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const user = await getCurrentOwner();
  const payload = await request.json() as { timezone?: string; dailyMinutes?: number; displayName?: string };
  if (payload.displayName !== undefined && (typeof payload.displayName !== "string" || payload.displayName.trim().length > 40)) {
    return Response.json({ error: "显示姓名请控制在 40 个字符以内" }, { status: 400 });
  }
  const timezone = payload.timezone?.trim() || "America/Toronto";
  const dailyMinutes = Math.max(30, Math.min(720, Number(payload.dailyMinutes) || 150));
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { return Response.json({ error: "无效时区" }, { status: 400 }); }
  await saveSettings(user!.userId, timezone, dailyMinutes, payload.displayName?.trim());
  return Response.json(await getSettings(user!.userId));
}
