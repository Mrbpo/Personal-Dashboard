import { Badge } from "@/components/ui/badge";
import { PageFrame } from "@/components/page-frame";
import { requireOwnerPage } from "@/lib/authz";
import { listChanges } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function ChangesPage() {
  const { authorized } = await requireOwnerPage("/changes");
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="无法访问">请使用网站所有者账号登录。</PageFrame>;
  const changes = await listChanges().catch(() => []);
  return (
    <PageFrame eyebrow="CHANGE LOG" title="最近变更" description="比较每次同步，优先显示截止时间、要求和课程内容的变化。">
      <section className="space-y-4">
        {changes.length ? changes.map((change) => (
          <article key={change.id} className="rounded-3xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge>{change.courseCode}</Badge><Badge variant="outline">内容已更新</Badge><span className="ml-auto text-xs text-muted-foreground">{new Date(change.detectedAt).toLocaleString("zh-CN", { timeZone: "America/Toronto" })}</span></div>
            <h2 className="mt-3 font-semibold">{change.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Canvas 内容、日期或提交状态自上次同步后发生变化。</p>
          </article>
        )) : <div className="rounded-3xl border border-dashed bg-card p-10 text-center text-muted-foreground">完成至少两次同步后，这里会显示老师修改过的内容。</div>}
      </section>
    </PageFrame>
  );
}
