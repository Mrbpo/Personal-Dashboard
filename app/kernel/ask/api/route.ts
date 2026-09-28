import { getCurrentOwner } from '@/lib/authz';
import { askKernel } from '@/lib/kernel/ask';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const owner = await getCurrentOwner();
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });
  try {
    if (Number(request.headers.get('content-length') || 0) > 8000) return Response.json({ error: '问题过长' }, { status: 413 });
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object') return Response.json({ error: '请求无效' }, { status: 400 });
    const input = body as Record<string, unknown>;
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    const courseId = typeof input.courseId === 'string' ? input.courseId.trim() : '';
    const history = Array.isArray(input.history) ? input.history.filter((item): item is string => typeof item === 'string').slice(-4).map(item => item.slice(0, 500)) : [];
    if (question.length < 2 || question.length > 600 || courseId.length > 200) return Response.json({ error: '问题须为 2 至 600 字' }, { status: 400 });
    const result = await askKernel(owner.userId, question, courseId, history);
    return Response.json({ ...result, feedbackId: crypto.randomUUID() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error && error.message === '课程无效' ? error.message : '读取或生成回答失败，请稍后重试';
    return Response.json({ error: message }, { status: message === '课程无效' ? 400 : 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
