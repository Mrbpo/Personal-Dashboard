import { requireOwnerApi } from "@/lib/authz";
import { generatePiazzaWeekSummary, listPiazzaAiWeeks, piazzaWeekStart } from "@/lib/piazza-ai";

export const runtime = "nodejs";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json({ weeks: await listPiazzaAiWeeks() });
}

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const body = await request.json();
    const start = String(body.weekStart || "");
    if (piazzaWeekStart(start) !== start) return Response.json({ error: "请选择有效的周一日期" }, { status: 400 });
    return Response.json({ report: await generatePiazzaWeekSummary(start) });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const message = /日期|周一|没有已归档|配置 AI 服务|正在生成|预算不足|AI 总结/.test(raw) ? raw : "AI 总结暂时失败，请稍后重试";
    return Response.json({ error: message }, { status: /日期|请选择|没有已归档/.test(message) ? 400 : 503 });
  }
}
