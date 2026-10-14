import { requireOwnerApi } from "@/lib/authz";

export async function POST() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json({ error: '学习计划功能已停用，请查看首页截止作业。' }, { status: 410 });
}
