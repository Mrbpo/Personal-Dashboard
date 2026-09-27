import { requireOwnerApi } from '@/lib/authz';
import { kernel } from '@/lib/kernel/service';

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object') return Response.json({ error: '请求无效' }, { status: 400 });
    const { taskId, status } = input as Record<string, unknown>;
    if (typeof taskId !== 'string' || !taskId || taskId.length > 256 ||
      !['active', 'completed', 'ignored'].includes(String(status)))
      return Response.json({ error: '任务或状态无效' }, { status: 400 });
    await kernel.setTaskStatus(taskId, status as 'active' | 'completed' | 'ignored');
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '状态更新失败' }, { status: 500 });
  }
}
