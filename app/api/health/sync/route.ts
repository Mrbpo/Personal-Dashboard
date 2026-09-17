import { getCurrentOwner, requireOwnerApi } from '@/lib/authz';
import { syncHealth } from '@/lib/health';
import { getSettings } from '@/lib/repository';
import { sameOrigin } from '@/lib/service-vault';
export async function POST(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请求来源无效' }, { status: 403 });
  const user = await getCurrentOwner(); const settings = await getSettings(user!.userId);
  return Response.json(await syncHealth(settings.timezone), { headers: { 'Cache-Control': 'no-store' } });
}
