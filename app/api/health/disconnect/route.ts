import { requireOwnerApi } from '@/lib/authz';
import { deleteIntegrationConnection } from '@/lib/repository';
import { sameOrigin } from '@/lib/service-vault';
export async function POST(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请求来源无效' }, { status: 403 });
  await deleteIntegrationConnection('google-health');
  return Response.json({ ok: true });
}
