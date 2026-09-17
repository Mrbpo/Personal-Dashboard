import { requireOwnerApi } from "@/lib/authz";
import { syncPiazza } from "@/lib/piazza-sync";

export const runtime = "nodejs";

export async function POST() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    return Response.json(await syncPiazza());
  } catch (error) {
    const code = error instanceof Error ? error.message : "PIAZZA_SYNC_FAILED";
    const status = code === "PIAZZA_NOT_CONNECTED" ? 409 : 502;
    return Response.json({ error: code === "PIAZZA_NOT_CONNECTED" ? "请先连接 Piazza" : "Piazza 同步失败；如登录已失效，请重新连接" }, { status });
  }
}
