import { getCurrentOwner } from '@/lib/authz';
import { kernel } from '@/lib/kernel/service';

export async function POST(request: Request) {
  const owner = await getCurrentOwner();
  if (!owner) return Response.json({ error: '需要登录或有效 API Token' }, { status: 401 });
  try {
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object') return Response.json({ error: '请求无效' }, { status: 400 });
    const { candidateId, decision, reason } = input as Record<string, unknown>;
    if (typeof candidateId !== 'string' || !candidateId || candidateId.length > 256 ||
      (decision !== 'accept' && decision !== 'reject') ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 2000)
      return Response.json({ error: '候选事实、决定或理由无效' }, { status: 400 });
    await kernel.adjudicate(candidateId, decision, reason, owner.userId);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '审核失败' }, { status: 500 });
  }
}
