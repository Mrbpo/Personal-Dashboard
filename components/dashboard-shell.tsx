"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  LayoutDashboard,
  RefreshCw,
  Settings,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const demoCourses = [
  { id: "CSCA08", code: "CSCA08", name: "计算机科学导论", color: "#7c6cff", count: 3 },
  { id: "MATA31", code: "MATA31", name: "微积分 I", color: "#ff8b6b", count: 2 },
  { id: "CTLA02", code: "CTLA02", name: "学术写作", color: "#35b7a5", count: 1 },
];

const demoTasks = [
  {
    id: "a08-lab", course: "CSCA08", title: "完成 Lab 6 并检查提交格式",
    detail: "老师在公告中补充：必须同时提交 .py 文件和测试截图。",
    due: "今天 23:59", tone: "urgent", source: "公告 + 作业要求", confidence: "确定",
  },
  {
    id: "a31-quiz", course: "MATA31", title: "完成 Quiz 4",
    detail: "开放后仅有 45 分钟作答时间，提交后不能重试。",
    due: "明天 10:00", tone: "soon", source: "Canvas 作业", confidence: "确定",
  },
  {
    id: "a02-reading", course: "CTLA02", title: "阅读 Module 7 并准备课堂讨论",
    detail: "页面写明“下节课前完成”，Canvas 没有设置正式截止时间。",
    due: "需要确认", tone: "review", source: "Module 页面", confidence: "AI 推断",
  },
];

const nav = [
  { href: "/", label: "今日总览", icon: LayoutDashboard },
  { href: "/changes", label: "最近变更", icon: RefreshCw },
  { href: "/settings", label: "设置", icon: Settings },
];

const syncErrors: Record<string, string> = {
  CANVAS_TOKEN_NOT_CONFIGURED: "Canvas Token 尚未在服务器端配置",
  CANVAS_AUTH_FAILED: "Canvas Token 无效或已过期",
  CANVAS_RATE_LIMITED: "Canvas 暂时限制了请求，请稍后再试",
  CANVAS_REQUEST_FAILED_403: "Quercus 拒绝了这次云端连接；请检查学校的访问限制",
};

export function DashboardShell({ displayName }: { displayName: string }) {
  const [completed, setCompleted] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [data, setData] = useState<any>(null);

  const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const loadDashboard = useCallback(async () => {
    const response = await fetch("/api/dashboard?date=" + date);
    if (response.ok) setData(await response.json());
  }, [date]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const visibleCourses = data?.courses?.length
    ? data.courses.map((course: any, index: number) => ({
        ...course,
        color: ["#7c6cff", "#ff8b6b", "#35b7a5", "#6696ef", "#f1b849"][index % 5],
        count: data.tasks.filter((task: any) => task.courseId === course.id && task.localStatus === "active").length,
      }))
    : demoCourses;
  const visibleTasks = data?.tasks?.length
    ? data.tasks.filter((task: any) => task.localStatus !== "ignored").slice(0, 10).map((task: any) => ({
        id: task.id,
        course: task.courseCode,
        title: task.title,
        detail: task.action + (task.requirements?.length ? " · " + task.requirements.join("；") : ""),
        due: task.dueAt ? new Date(task.dueAt).toLocaleString("zh-CN", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "需要确认",
        tone: task.urgency,
        source: task.sourceType,
        sourceUrl: task.sourceUrl,
        confidence: task.confidence === "certain" ? "确定" : "AI 推断",
        localStatus: task.localStatus,
        estimatedMinutes: task.estimatedMinutes,
      }))
    : demoTasks;
  const estimatedMinutes = visibleTasks
    .filter((task: any) => !(completed.includes(task.id) || task.localStatus === "completed"))
    .reduce((total: number, task: any) => total + (task.estimatedMinutes || 45), 0);
  const loadPercent = Math.min(100, Math.round((estimatedMinutes / 240) * 100));
  const urgentCount = visibleTasks.filter((task: any) => task.tone === "urgent").length;
  const soonCount = visibleTasks.filter((task: any) => task.tone === "soon").length;
  const reviewCount = visibleTasks.filter((task: any) => task.tone === "review").length;
  const recentChanges = data?.changes?.length ? data.changes.slice(0, 3) : [
    { id: "demo-1", title: "Lab 6 新增提交要求", courseCode: "CSCA08", type: "content_updated" },
    { id: "demo-2", title: "Essay Draft 延后 2 天", courseCode: "CTLA02", type: "dates_updated" },
  ];

  async function previewSync() {
    setSyncing(true);
    setSyncMessage("正在连接 Quercus…");
    try {
      const startResponse = await fetch("/api/sync", { method: "POST" });
      const start = await startResponse.json();
      if (!startResponse.ok) throw new Error(start.error || "无法开始同步");
      const failedCourses: string[] = [];
      for (let index = 0; index < start.courses.length; index += 1) {
        const course = start.courses[index];
        setSyncMessage("正在分析 " + course.code + "（" + (index + 1) + "/" + start.courses.length + "）");
        const courseResponse = await fetch("/api/sync/courses/" + course.id + "?runId=" + start.runId, { method: "POST" });
        if (!courseResponse.ok) failedCourses.push(course.code);
      }
      setSyncMessage("正在生成今日计划…");
      await fetch("/api/plans/" + date + "/generate", { method: "POST" });
      await loadDashboard();
      setSyncMessage(failedCourses.length ? "同步完成；" + failedCourses.join("、") + " 暂时失败" : "同步完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步失败";
      setSyncMessage(syncErrors[message] || message);
    } finally {
      setTimeout(() => setSyncing(false), 450);
    }
  }

  async function toggleTask(task: any, done: boolean) {
    setCompleted((items) => done ? items.filter((id) => id !== task.id) : [...items, task.id]);
    if (data?.tasks?.length) {
      await fetch("/api/tasks/" + encodeURIComponent(task.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: done ? "active" : "completed" }),
      });
      await loadDashboard();
    }
  }

  return (
    <SidebarProvider>
      <Sidebar className="border-r-0 p-3 pr-0" variant="sidebar">
        <SidebarHeader className="px-3 pb-5 pt-4">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_24px_rgba(62,82,255,.28)]">
              <Sparkles className="size-5" />
            </div>
            <div>
              <p className="font-semibold tracking-tight">Course Radar</p>
              <p className="text-xs text-sidebar-foreground/55">Quercus 学习助手</p>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((item, index) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={index === 0} tooltip={item.label}>
                      <Link href={item.href}><item.icon /><span>{item.label}</span></Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>本学期课程</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {visibleCourses.map((course: any) => (
                  <SidebarMenuItem key={course.code}>
                    <SidebarMenuButton asChild tooltip={course.name}>
                      <Link href={"/courses/" + course.id}>
                        <span className="size-2.5 rounded-full" style={{ background: course.color }} />
                        <span>{course.code}</span>
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>{course.count}</SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-3 pb-4">
          <div className="rounded-2xl border border-sidebar-border bg-sidebar-accent/50 p-3">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="mt-1 text-xs text-sidebar-foreground/55">私人学习空间</p>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/70 bg-background/88 px-4 backdrop-blur-xl md:px-8">
          <div className="flex items-center gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <p className="text-xs font-medium uppercase tracking-[.14em] text-muted-foreground">America / Toronto</p>
              <p className="text-sm font-medium">今日学习总览</p>
            </div>
          </div>
          <Button onClick={previewSync} disabled={syncing} className="rounded-xl" size="sm">
            <RefreshCw className={syncing ? "animate-spin" : ""} />
            {syncing ? "正在同步" : "同步 Canvas"}
          </Button>
        </header>
        {syncMessage && (
          <div aria-live="polite" className="border-b border-primary/10 bg-primary/5 px-4 py-2 text-center text-sm text-primary md:px-8">
            {syncMessage}
          </div>
        )}

        <main className="mx-auto w-full max-w-[1480px] px-4 py-7 md:px-8 md:py-10">
          <section className="mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <Badge variant="outline" className="mb-4 border-primary/20 bg-primary/5 text-primary">
                {data?.courses?.length ? "Canvas 数据 · " + (data.lastSync?.status === "complete" ? "已同步" : "准备就绪") : "演示数据 · 等待首次同步"}
              </Badge>
              <h1 className="text-3xl font-semibold tracking-[-.035em] md:text-[2.65rem]">早上好，{displayName}</h1>
              <p className="mt-2 max-w-2xl text-base text-muted-foreground">
                今天有 {visibleTasks.filter((task: any) => ["urgent", "soon"].includes(task.tone)).length} 项优先任务，
                另有 {visibleTasks.filter((task: any) => task.tone === "review").length} 项需要确认。
              </p>
            </div>
            <div className="flex items-center gap-4 rounded-2xl border bg-card px-5 py-4 shadow-sm">
              <div className="relative grid size-14 place-items-center rounded-full bg-primary/10 text-lg font-semibold text-primary">{visibleTasks.filter((task: any) => completed.includes(task.id) || task.localStatus === "completed").length}<span className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-card bg-amber-400" /></div>
              <div><p className="text-sm font-medium">今日进度</p><p className="text-sm text-muted-foreground">预计还需 {Math.floor(estimatedMinutes / 60)} 小时 {estimatedMinutes % 60} 分</p></div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
            <section className="space-y-4" aria-labelledby="must-do-title">
              <div className="flex items-center justify-between">
                <div><p className="section-kicker">FOCUS</p><h2 id="must-do-title" className="text-xl font-semibold">现在要做</h2></div>
                <span className="text-sm text-muted-foreground">{visibleTasks.filter((task: any) => completed.includes(task.id) || task.localStatus === "completed").length}/{visibleTasks.length} 完成</span>
              </div>
              {visibleTasks.map((task: any) => {
                const done = completed.includes(task.id) || task.localStatus === "completed";
                return (
                  <article key={task.id} className={"task-card task-" + task.tone + (done ? " opacity-55" : "")}>
                    <button
                      className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border-2 border-current transition hover:scale-105"
                      aria-label={done ? "恢复 " + task.title : "完成 " + task.title}
                      onClick={() => void toggleTask(task, done)}
                    >{done && <Check className="size-4" />}</button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{task.course}</Badge>
                        <span className="text-sm font-medium text-muted-foreground">{task.due}</span>
                        <Badge variant="outline" className="ml-auto">{task.confidence}</Badge>
                      </div>
                      <h3 className={"mt-3 text-lg font-semibold " + (done ? "line-through" : "")}>{task.title}</h3>
                      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{task.detail}</p>
                      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><FileText className="size-3.5" />来源：{task.source}</div>
                    </div>
                    <Button asChild={Boolean(task.sourceUrl)} variant="ghost" size="icon" className="shrink-0 rounded-full" aria-label="查看来源">
                      {task.sourceUrl ? <a href={task.sourceUrl} target="_blank" rel="noreferrer"><ChevronRight /></a> : <ChevronRight />}
                    </Button>
                  </article>
                );
              })}
            </section>

            <aside className="space-y-6">
              <section className="rounded-3xl bg-[#141c31] p-6 text-white shadow-[0_18px_50px_rgba(20,28,49,.18)]">
                <div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-white/50">TODAY</p><h2 className="mt-1 text-xl font-semibold">学习负荷</h2></div><Clock3 className="text-[#8d9cff]" /></div>
                <div className="mt-7 flex items-end justify-between"><div><span className="text-4xl font-semibold">{Math.floor(estimatedMinutes / 60)}h {estimatedMinutes % 60}m</span><p className="mt-1 text-sm text-white/55">基于 {visibleTasks.length} 项任务估算</p></div><span className="text-sm text-[#aeb7ff]">{loadPercent}%</span></div>
                <Progress value={loadPercent} className="mt-4 h-2 bg-white/10 [&>div]:bg-[#8291ff]" />
                <div className="mt-6 grid grid-cols-3 gap-2 text-center text-xs text-white/60"><div><b className="block text-base text-white">{urgentCount}</b>紧急</div><div><b className="block text-base text-white">{soonCount}</b>即将</div><div><b className="block text-base text-white">{reviewCount}</b>确认</div></div>
              </section>

              <section className="rounded-3xl border bg-card p-6 shadow-sm">
                <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-amber-100 text-amber-700"><AlertTriangle className="size-4" /></span><div><p className="font-semibold">最近变更</p><p className="text-xs text-muted-foreground">{data?.lastSync ? "最近一次同步已记录" : "上次检查：尚未同步"}</p></div></div>
                <div className="mt-5 space-y-4">
                  {recentChanges.map((change: any) => (
                    <div key={change.id} className={`border-l-2 ${change.type === "dates_updated" ? "border-sky-400" : "border-amber-400"} pl-4`}>
                      <p className="text-sm font-medium">{change.title}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{change.courseCode} · {change.type === "dates_updated" ? "截止时间变更" : "内容要求变更"}</p>
                    </div>
                  ))}
                </div>
                <Button asChild variant="outline" className="mt-5 w-full rounded-xl"><Link href="/changes">查看所有变更</Link></Button>
              </section>

              <section className="rounded-3xl border bg-card p-6 shadow-sm">
                <div className="flex items-center gap-2"><CalendarDays className="size-4 text-primary" /><h2 className="font-semibold">未来 7 天</h2></div>
                <div className="mt-5 space-y-4">
                  {visibleCourses.map((course: any, index: number) => (
                    <Link href={"/courses/" + course.id} key={course.id} className="group flex items-center gap-3">
                      <span className="grid size-9 place-items-center rounded-xl text-sm font-semibold" style={{ background: course.color + "1f", color: course.color }}>{index + 1}</span>
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{course.code}</p><p className="truncate text-xs text-muted-foreground">{course.name}</p></div>
                      <span className="text-sm font-semibold">{course.count}</span>
                    </Link>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
