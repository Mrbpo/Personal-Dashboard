import { Badge } from "@/components/ui/badge";
import { PageFrame } from "@/components/page-frame";
import { requireOwnerPage } from "@/lib/authz";
import { getCourseDetail } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const { authorized } = await requireOwnerPage("/courses/" + courseId);
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="无法访问">请使用网站所有者账号登录。</PageFrame>;
  const detail = await getCourseDetail(courseId).catch(() => null);
  if (!detail) return <PageFrame eyebrow="COURSE" title="课程尚未同步" description="返回今日总览并运行一次 Canvas 同步。"><div /></PageFrame>;
  return (
    <PageFrame eyebrow={detail.course.code} title={detail.course.name} description={detail.summary?.text || "课程资料已同步，等待进一步分析。"}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">待办与提醒</h2>
          {detail.tasks.length ? detail.tasks.map((task) => (
            <article key={task.id} className={"task-card task-" + task.urgency}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2"><Badge variant="secondary">{task.canvasStatus}</Badge><Badge variant="outline">{task.confidence === "certain" ? "确定" : "AI 推断"}</Badge></div>
                <h3 className="mt-3 text-lg font-semibold">{task.title}</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{task.action}</p>
                {task.requirements.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{task.requirements.map((item) => <li key={item}>{item}</li>)}</ul>}
                <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{task.dueAt ? new Date(task.dueAt).toLocaleString("zh-CN", { timeZone: "America/Toronto" }) : "没有确定截止时间"}</span>
                  {task.sourceUrl && <a className="font-medium text-primary hover:underline" href={task.sourceUrl} target="_blank" rel="noreferrer">打开 Canvas 来源</a>}
                </div>
              </div>
            </article>
          )) : <div className="rounded-3xl border border-dashed bg-card p-8 text-muted-foreground">这门课暂时没有提取到待办事项。</div>}
        </section>
        <aside className="space-y-5">
          <section className="rounded-3xl border bg-card p-6 shadow-sm"><h2 className="font-semibold">需要优先关注</h2><ul className="mt-4 space-y-3 text-sm text-muted-foreground">{detail.summary?.priorities?.length ? detail.summary.priorities.map((item: string) => <li key={item}>• {item}</li>) : <li>暂无额外优先事项</li>}</ul></section>
          <section className="rounded-3xl border bg-card p-6 shadow-sm"><h2 className="font-semibold">已读取内容</h2><div className="mt-4 space-y-3">{detail.sources.slice(0, 12).map((source) => <div key={source.id} className="flex items-start justify-between gap-3 text-sm"><div><p className="font-medium">{source.title}</p><p className="text-xs text-muted-foreground">{source.type}</p></div><Badge variant="outline">{source.analysisStatus === "complete" ? "已分析" : "规则"}</Badge></div>)}</div></section>
        </aside>
      </div>
    </PageFrame>
  );
}
