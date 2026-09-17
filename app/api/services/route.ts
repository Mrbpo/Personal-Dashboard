import { requireOwnerApi } from '@/lib/authz';
import { sameOrigin, saveServiceValues, serviceStatus } from '@/lib/service-vault';
export async function GET() {
  const denied = await requireOwnerApi(); if (denied) return denied;
  return Response.json(serviceStatus(), { headers: { 'Cache-Control': 'no-store' } });
}
export async function PUT(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请从本站设置页保存' }, { status: 403 });
  try {
    if (Number(request.headers.get('content-length')) > 100000) throw new Error();
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    saveServiceValues(body);
    return Response.json(serviceStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: '配置未保存，请检查填写内容' }, { status: 400 }); }
}
