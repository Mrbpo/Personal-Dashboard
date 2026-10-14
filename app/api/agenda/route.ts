import { requireOwnerApi } from '@/lib/authz';

async function retired() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json({ error: '学习计划功能已停用，请查看首页截止作业。' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
export const GET = retired;
export const POST = retired;
