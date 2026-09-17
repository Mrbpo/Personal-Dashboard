import { requireOwnerApi } from "@/lib/authz";
import { listShortcuts, saveShortcut } from "@/lib/repository";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json({ shortcuts: await listShortcuts() });
}

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const body = await request.json();
    const title = String(body.title || "").trim().slice(0, 80);
    const parsed = new URL(String(body.url || "").trim());
    if (!title || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("INVALID_SHORTCUT");
    parsed.hash = "";
    const url = parsed.toString();
    const iconUrl = new URL("/favicon.ico", parsed.origin).toString();
    const id = await saveShortcut(title, url, iconUrl);
    return Response.json({ id, title, url, iconUrl }, { status: 201 });
  } catch {
    return Response.json({ error: "请输入有效的网站名称和 http/https 地址" }, { status: 400 });
  }
}
