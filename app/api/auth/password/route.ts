import { requireOwnerApi } from '@/lib/authz';
import { ownerPasswordError, saveOwnerPassword } from '@/lib/owner-password';
import { sameOrigin } from '@/lib/service-vault';

export async function PUT(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请从本站设置页修改密码' }, { status: 403 });
  if (Number(request.headers.get('content-length')) > 4096) return Response.json({ error: '请求无效' }, { status: 400 });
  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  if (!body || typeof body.password !== 'string') return Response.json({ error: '请输入新密码' }, { status: 400 });
  const error = ownerPasswordError(body.password);
  if (error) return Response.json({ error }, { status: 400 });
  saveOwnerPassword(body.password);
  return Response.json({ ok: true });
}
