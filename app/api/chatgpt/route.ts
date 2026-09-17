import { requireOwnerApi } from '@/lib/authz';
import { codexBridge } from '@/lib/codex-bridge';
import { sameOrigin, saveServiceValues } from '@/lib/service-vault';
export const runtime = 'nodejs';
export async function GET() {
  const denied = await requireOwnerApi(); if (denied) return denied;
  return Response.json(await codexBridge.status(), { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请从本站操作' }, { status: 403 });
  try {
    const { action } = await request.json();
    if (action === 'login') return Response.json(await codexBridge.login());
    if (action !== 'enable' && action !== 'disable') return Response.json({ error: '无效操作' }, { status: 400 });
    saveServiceValues({ CHATGPT_AUTO: action === 'enable' ? 'true' : 'false' });
    return Response.json(await codexBridge.status());
  } catch { return Response.json({ error: '无法连接本机 Codex，请检查程序路径或重新登录。' }, { status: 503 }); }
}
