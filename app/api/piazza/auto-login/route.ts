import { requireOwnerApi } from "@/lib/authz";
import { deletePiazzaAutoLogin } from "@/lib/piazza-auto-login";
import { sameOrigin } from "@/lib/service-vault";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: "请从本站设置页关闭自动重登" }, { status: 403 });
  await deletePiazzaAutoLogin();
  return Response.json({ autoLoginEnabled: false });
}
