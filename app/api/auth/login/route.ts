import { cookies } from "next/headers";
import { createOwnerSession, verifyOwnerAccessKey } from "@/lib/authz";
import { sameOrigin } from '@/lib/service-vault';

export async function POST(request: Request) {
  if(!sameOrigin(request))return Response.json({error:'请求来源无效'},{status:403});
  const body = await request.json().catch(() => null) as { accessKey?: string } | null;
  if (!body?.accessKey || !verifyOwnerAccessKey(body.accessKey)) return Response.json({ error: "访问密码不正确" }, { status: 401 });
  const session = createOwnerSession();
  if (!session) return Response.json({ error: "服务器尚未配置私人访问" }, { status: 503 });
  (await cookies()).set("course_radar_session", session, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return Response.json({ ok: true });
}
