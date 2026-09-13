import { env } from "cloudflare:workers";
import { getChatGPTUser, requireChatGPTUser } from "@/app/chatgpt-auth";

export async function requireOwnerPage(returnTo: string) {
  const user = await requireChatGPTUser(returnTo);
  const allowed = typeof env.OWNER_EMAIL === "string" ? env.OWNER_EMAIL.trim().toLowerCase() : "";
  return { user, authorized: !allowed || user.email.toLowerCase() === allowed };
}

export async function requireOwnerApi(): Promise<Response | null> {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const allowed = typeof env.OWNER_EMAIL === "string" ? env.OWNER_EMAIL.trim().toLowerCase() : "";
  if (allowed && user.email.toLowerCase() !== allowed) {
    return Response.json({ error: "没有访问权限" }, { status: 403 });
  }
  return null;
}
