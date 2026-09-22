import { requireOwnerApi } from "@/lib/authz";
import { answerPiazzaQuestion, piazzaWeekStart } from "@/lib/piazza-ai";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  try {
    const body = await request.json();
    const week = String(body.weekStart || "");
    if (week && piazzaWeekStart(week) !== week) return Response.json({ error: "请选择有效的周一日期" }, { status: 400 });
    return Response.json(await answerPiazzaQuestion(String(body.question || ""), week));
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const message = /请输入|日期|周一|配置 AI 服务|预算不足|AI 问答|AI 回答/.test(raw) ? raw : "AI 问答暂时失败，请稍后重试";
    return Response.json({ error: message }, { status: /请输入|日期|请选择/.test(message) ? 400 : 503 });
  }
}
