import { cookies } from "next/headers";
import { createOwnerSession, verifyOwnerAccessKey } from "@/lib/authz";
import { sameOrigin } from '@/lib/service-vault';

const attempts = new Map<string, { failures: number; blockedUntil: number; updatedAt: number }>();
function clientAddress(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map(value => value.trim()).filter(Boolean);
  return request.headers.get('x-real-ip') || forwarded?.at(-1) || 'unknown';
}

export async function POST(request: Request) {
  if(!sameOrigin(request))return Response.json({error:'请求来源无效'},{status:403});
  const address = clientAddress(request), now = Date.now(), attempt = attempts.get(address);
  if (attempts.size > 1000) for (const [key, value] of attempts) if (value.updatedAt < now - 15 * 60 * 1000) attempts.delete(key);
  if (attempt?.blockedUntil && attempt.blockedUntil > now) return Response.json({ error: '尝试次数过多，请 15 分钟后再试' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((attempt.blockedUntil - now) / 1000)) } });
  if (Number(request.headers.get('content-length')) > 4096) return Response.json({ error: '请求无效' }, { status: 400 });
  const body = await request.json().catch(() => null) as { accessKey?: string } | null;
  if (!body?.accessKey || !verifyOwnerAccessKey(body.accessKey)) {
    const failures = (attempt?.failures || 0) + 1;
    attempts.set(address, { failures, blockedUntil: failures >= 5 ? now + 15 * 60 * 1000 : 0, updatedAt: now });
    return Response.json({ error: "访问密码不正确" }, { status: 401 });
  }
  attempts.delete(address);
  const session = createOwnerSession();
  if (!session) return Response.json({ error: "服务器尚未配置私人访问" }, { status: 503 });
  (await cookies()).set("course_radar_session", session, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return Response.json({ ok: true });
}
