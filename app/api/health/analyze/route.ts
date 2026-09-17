import { requireOwnerApi } from '@/lib/authz';
import { analyzeHealth } from '@/lib/health';
import { sameOrigin } from '@/lib/service-vault';
export async function POST(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请求来源无效' }, { status: 403 });
  try { return Response.json(await analyzeHealth(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return Response.json({ error: '分析暂不可用，请确认已有同步数据及有效的 OpenAI 配置' }, { status: 503 }); }
}
