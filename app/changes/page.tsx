import { Badge } from "@/components/ui/badge";
import { PageFrame } from "@/components/page-frame";
import { requireOwnerPage } from "@/lib/authz";
import { getSettings, listChanges } from "@/lib/repository";

export const dynamic = "force-dynamic";

const changeLabels: Record<string, string> = { dates_updated: "截止时间已变更", content_updated: "内容要求已变更", submission_updated: "提交状态已变更", attachment_updated: "附件已变更", prerequisite_updated: "先修条件已变更", source_missing: "来源疑似失效", restored: "来源已恢复" };

function changeDetail(change: any, timezone: string) {
  if (change.type === "dates_updated") {
    const before = change.before?.dates?.dueAt ? new Date(change.before.dates.dueAt).toLocaleString("zh-CN", { timeZone: timezone }) : "未设置";
    const after = change.after?.dates?.dueAt ? new Date(change.after.dates.dueAt).toLocaleString("zh-CN", { timeZone: timezone }) : "未设置";
    return `截止时间：${before} → ${after}`;
  }
  if (change.type === "source_missing") return "这项内容在最新一次完整同步中没有再次出现，请打开 Canvas 确认是否被删除、隐藏或替代。";
  if (change.type === "restored") return "此前失效的来源重新出现在 Canvas 中。";
  return "标题、正文、附件或提交状态发生变化；请打开课程来源核对最新要求。";
}

export default async function ChangesPage() {
  const { authorized, user } = await requireOwnerPage("/changes");
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="无法访问">请使用网站所有者账号登录。</PageFrame>;
  const changes = await listChanges().catch(() => []);
  const { timezone } = await getSettings(user.userId);
  return (
    <PageFrame ornament eyebrow="CHANGE LOG" title="最近变更">
      <section className="space-y-4">
        {changes.length ? changes.map((change) => (
          <article key={change.id} className="rounded-3xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge>{change.courseCode}</Badge><Badge variant="outline">{changeLabels[change.type] || change.type}</Badge><span className="ml-auto text-xs text-muted-foreground">{new Date(change.detectedAt).toLocaleString("zh-CN", { timeZone: timezone })}</span></div>
            <h2 className="mt-3 font-semibold">{change.title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{changeDetail(change, timezone)}</p>
          </article>
        )) : <div className="rounded-3xl border border-dashed bg-card p-10 text-center text-muted-foreground">完成至少两次同步后，这里会显示老师修改过的内容。</div>}
      </section>
    </PageFrame>
  );
}
