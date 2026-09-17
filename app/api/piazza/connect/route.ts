import { requireOwnerApi } from "@/lib/authz";
import { deleteIntegrationConnection } from "@/lib/repository";
import { connectPiazza } from "@/lib/piazza-sync";

export const runtime = "nodejs";

function publicError(error: unknown) {
  const code = error instanceof Error ? error.message : "PIAZZA_CONNECT_FAILED";
  if (code === "PIAZZA_AUTH_FAILED") return { message: "Piazza 邮箱或密码不正确", status: 401 };
  if (code === "PIAZZA_ENCRYPTION_NOT_CONFIGURED") return { message: "请先在服务器配置 SESSION_SECRET", status: 503 };
  return { message: "暂时无法连接 Piazza，请稍后再试", status: 502 };
}

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const body = await request.json();
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || !password || email.length > 254 || password.length > 512) {
      return Response.json({ error: "请输入有效的 Piazza 邮箱和密码" }, { status: 400 });
    }
    return Response.json(await connectPiazza(email, password), { status: 201 });
  } catch (error) {
    const safe = publicError(error);
    return Response.json({ error: safe.message }, { status: safe.status });
  }
}

export async function DELETE() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  await deleteIntegrationConnection("piazza");
  return Response.json({ connected: false });
}
