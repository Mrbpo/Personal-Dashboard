import { CalendarClock, CheckCircle2, Clock3, Database, Layers3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageFrame } from "@/components/page-frame";
import { CourseLibrary } from "@/components/course-library";
import { TaskStatusButton } from "@/components/task-status-button";
import { requireOwnerPage } from "@/lib/authz";
import { presentCourse } from "@/lib/course-presentation";
import { getCourseDetail, getSettings } from "@/lib/repository";
import { statusLabels } from "@/lib/task-rules";
import { conciseRequirement, conciseTaskAction } from "@/lib/task-presentation";
import type { LearningTask } from "@/lib/domain";

export const dynamic = "force-dynamic";

function formatDate(value: string | null, timezone: string) {
  if (!value) return "未设置";
  return new Date(value).toLocaleString("zh-CN", { timeZone: timezone, month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function usefulBrief(text?: string | null) {
  if (!text) return "";
  const parts = (text.match(/[^。！？.!?]+[。！？.!?]?/g) || []).map((item) => item.trim()).filter(Boolean);
  const useful = parts.filter((item) => !/(module|模块).{0,12}(已完成|完成|completed)|无需(进一步|学生)?(采取)?(操作|行动)/i.test(item));
  return [...new Set(useful)].slice(0, 4).join(" ");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function TaskRow({ task, timezone }: { task: LearningTask; timezone: string }) {
  return (
    <details className="group border bg-card open:ring-1 open:ring-[#9b8350]/40">
      <summary className="flex cursor-pointer list-none items-start gap-3 p-4 md:items-center">
        <span className={`mt-1 size-2.5 shrink-0 rounded-full md:mt-0 ${task.urgency === "urgent" ? "bg-rose-500" : task.urgency === "soon" ? "bg-amber-400" : task.urgency === "upcoming" ? "bg-emerald-400" : "bg-sky-400"}`} />
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold leading-5">{conciseTaskAction(task)}</p><p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{conciseRequirement(task)}</p></div>
        <div className="hidden shrink-0 text-right sm:block"><p className="text-sm font-medium">{task.dueAt ? formatDate(task.dueAt, timezone) : statusLabels[task.canvasStatus]}</p><p className="mt-1 text-xs text-muted-foreground">{task.pointsPossible != null ? `${task.pointsPossible} 分` : "点击查看详情"}</p></div>
      </summary>
      <div className="border-t px-4 py-4 md:px-7">
        <div className="flex flex-wrap gap-2"><Badge variant="secondary">{statusLabels[task.canvasStatus]}</Badge><Badge variant="outline">{task.confidence === "certain" ? "Canvas 确定信息" : "AI 推断"}</Badge>{task.pointsPossible != null && <Badge variant="outline">{task.pointsPossible} 分</Badge>}</div>
        <h3 className="mt-4 break-words text-base font-semibold [overflow-wrap:anywhere]">{task.title}</h3>
        {task.action && <p className="mt-2 text-sm leading-6 text-muted-foreground">{task.action}</p>}
        {task.requirements.length > 0 && <div className="mt-4"><p className="text-sm font-semibold">具体要求</p><ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">{task.requirements.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        <div className="mt-4 grid gap-2 border border-[#c1b69d] bg-muted/60 p-3 text-sm sm:grid-cols-3"><span>建议开始：{formatDate(task.startAt, timezone)}</span><span>截止：{formatDate(task.dueAt, timezone)}</span><span>关闭：{formatDate(task.lockAt, timezone)}</span></div>
        {task.evidence && <blockquote className="mt-4 border-l-2 border-primary/30 pl-3 text-sm leading-6 text-muted-foreground">分析依据：{task.evidence}</blockquote>}
        <div className="mt-4 flex flex-wrap items-center gap-3">{task.sourceUrl && <a className="text-sm font-medium text-primary hover:underline" href={task.sourceUrl} target="_blank" rel="noreferrer">打开 Canvas 原文</a>}{task.localStatus === "completed" && <TaskStatusButton taskId={task.id} />}</div>
      </div>
    </details>
  );
}

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const { authorized, user } = await requireOwnerPage(`/courses/${courseId}`);
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="无法访问">请使用网站所有者账号登录。</PageFrame>;
  const detail = await getCourseDetail(courseId).catch(() => null);
  const { timezone } = await getSettings(user.userId);
  if (!detail) return <PageFrame eyebrow="COURSE" title="课程尚未同步" description="返回今日总览并等待下一次自动同步。"><div /></PageFrame>;

  const { displayCode, courseTitle } = presentCourse(detail.course.code, detail.course.name);
  const modules = detail.sources.filter((source) => source.type === "module" && source.active);
  const completedModules = modules.filter((source) => /Module 状态：(completed|已完成)/i.test(source.body)).length;
  const activeTasks = detail.tasks.filter((task) => task.localStatus === "active" && !["completed", "locked", "not_open", "possibly_superseded"].includes(task.canvasStatus));
  const completedTasks = detail.tasks.filter((task) => task.localStatus === "completed" || task.canvasStatus === "completed");
  const reviewTasks = detail.tasks.filter((task) => !activeTasks.includes(task) && !completedTasks.includes(task));
  const piazzaCount = detail.sources.filter((source) => source.active && source.type === "piazza").length;
  const brief = usefulBrief(detail.summary?.text);
  const priorities = [...new Set(stringList(detail.summary?.priorities))].filter((item) => !/(module|模块).{0,12}(已完成|完成|completed)|无需(进一步|学生)?(采取)?(操作|行动)/i.test(item)).slice(0, 4);
  const risks = [...new Set(stringList(detail.summary?.risks))].filter((item) => !/(module|模块).{0,12}(已完成|完成|completed)/i.test(item)).slice(0, 4);
  const stats = [
    { icon: Clock3, label: "待处理", value: activeTasks.length, detail: "按截止时间与状态排序" },
    { icon: CheckCircle2, label: "已完成", value: completedTasks.length, detail: "Canvas 与本站状态" },
    { icon: Layers3, label: "Modules", value: `${completedModules}/${modules.length}`, detail: "Canvas 模块进度" },
    { icon: Database, label: "课程资料", value: detail.sources.filter((source) => source.active).length, detail: piazzaCount ? `含 ${piazzaCount} 条 Piazza` : "公告、文件与页面" },
  ];

  return (
    <PageFrame eyebrow={`COURSE · ${detail.course.termName || "当前学期"}`} title={displayCode} description={courseTitle}>
      <section className="course-stats mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => <div key={stat.label} className="parchment-panel p-3.5"><div className="relative flex items-center gap-2 text-xs text-muted-foreground"><stat.icon className="size-4 text-primary" />{stat.label}</div><p className="relative mt-1 text-xl font-semibold">{stat.value}</p><p className="relative mt-0.5 text-xs text-muted-foreground">{stat.detail}</p></div>)}
      </section>

      {(brief || priorities.length || risks.length) && <section className="instrument-panel instrument-purple mb-6 grid gap-4 p-4 md:p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <div className="relative"><p className="text-[10px] font-bold uppercase tracking-[.17em] text-[#c6aa6b]">COURSE BRIEF</p><h2 className="mt-1 text-lg font-semibold">这门课目前的重点</h2><p className="mt-2 text-sm leading-7 text-white/70">{brief || "没有需要重复提醒的课程级事项；请直接查看下方任务和资料。"}</p></div>
        <div className="relative grid gap-3 sm:grid-cols-2 lg:grid-cols-1"><div className="border border-white/10 bg-black/10 p-3"><p className="text-sm font-semibold">优先事项</p><ul className="mt-2 space-y-1.5 text-sm leading-6 text-white/65">{priorities.length ? priorities.map((item) => <li key={item}>• {item}</li>) : <li>暂无额外优先事项</li>}</ul></div>{risks.length > 0 && <div className="border border-amber-300/20 bg-amber-950/15 p-3"><p className="text-sm font-semibold text-[#dcc483]">需要留意</p><ul className="mt-2 space-y-1.5 text-sm leading-6 text-white/65">{risks.map((item) => <li key={item}>• {item}</li>)}</ul></div>}</div>
      </section>}

      <CourseLibrary sources={detail.sources} timezone={timezone} />

      <section className="parchment-panel mt-6 p-1">
        <div className="flex flex-col gap-2 px-4 pb-4 pt-5 sm:flex-row sm:items-end sm:justify-between md:px-6"><div><p className="section-kicker">TASK DETAILS</p><h2 className="text-xl font-semibold md:text-2xl">任务、截止时间与完整要求</h2><p className="mt-1 text-sm text-muted-foreground">点击任一任务，查看要求、时间、AI 判断和原始依据。</p></div><span className="flex items-center gap-2 text-sm text-muted-foreground"><CalendarClock className="size-4" />{activeTasks.length} 项待处理</span></div>
        <div className="space-y-2 p-2 md:p-3">{activeTasks.length ? activeTasks.map((task) => <TaskRow key={task.id} task={task} timezone={timezone} />) : <div className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">这门课当前没有待处理任务。</div>}</div>
        {reviewTasks.length > 0 && <details className="m-2 rounded-2xl border bg-card p-4 md:m-3"><summary className="cursor-pointer font-semibold">需要确认或暂不可用 <span className="ml-1 text-sm font-normal text-muted-foreground">{reviewTasks.length} 项</span></summary><div className="mt-4 space-y-2">{reviewTasks.map((task) => <TaskRow key={task.id} task={task} timezone={timezone} />)}</div></details>}
        {completedTasks.length > 0 && <details className="m-2 rounded-2xl border bg-card p-4 md:m-3"><summary className="cursor-pointer font-semibold">已完成 <span className="ml-1 text-sm font-normal text-muted-foreground">{completedTasks.length} 项</span></summary><div className="mt-4 space-y-2 opacity-75">{completedTasks.map((task) => <TaskRow key={task.id} task={task} timezone={timezone} />)}</div></details>}
      </section>
    </PageFrame>
  );
}
