"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Clock3,
  LayoutDashboard,
  Search,
  Cpu,
  Grid2X2,
  GraduationCap,
  PenLine,
  HeartPulse,
  Landmark,
  Languages,
  MessageSquareText,
  RefreshCw,
  Settings,
} from "lucide-react";
import { DueDayList } from '@/components/due-day-list';
import { CourseAssistant } from "@/components/course-assistant";
import { AiUsagePanel } from "@/components/ai-usage-panel";
import { ShortcutPanel } from "@/components/shortcut-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { conciseRequirement, conciseTaskAction } from "@/lib/task-presentation";
import { presentCourse } from "@/lib/course-presentation";
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

const nav = [
  { href: "/", label: "总 Dashboard", icon: LayoutDashboard },
  { href: "/#global-search", label: "全站检索", icon: Search },
  { href: "/#learning", label: "学习中心", icon: GraduationCap },
  { href: "/study", label: "学习对话与档案", icon: GraduationCap },
  { href: "/sketch", label: "绘画问 AI", icon: PenLine },
  { href: "/library", label: "本地资料库", icon: Grid2X2 },
  { href: "/piazza", label: "Piazza 摘要与问答", icon: MessageSquareText },
  { href: "/vocabulary", label: "生词本", icon: Languages },
  { href: "/mail", label: "邮件中心", icon: Search },
  { href: "/health", label: "健康与 AI 分析", icon: HeartPulse },
  { href: "/#ai-usage", label: "AI 用量", icon: Cpu },
  { href: "/#shortcuts", label: "快捷入口", icon: Grid2X2 },
  { href: "/changes", label: "最近变更", icon: RefreshCw },
  { href: "/settings", label: "设置", icon: Settings },
];

const syncErrors: Record<string, string> = {
  CANVAS_TOKEN_NOT_CONFIGURED: "Canvas Token 尚未在服务器端配置",
  CANVAS_AUTH_FAILED: "Canvas Token 无效或已过期",
  CANVAS_RATE_LIMITED: "Canvas 暂时限制了请求，请稍后再试",
  CANVAS_REQUEST_FAILED_403: "Quercus 拒绝了这次云端连接；请检查学校的访问限制",
};

const sourceLabels: Record<string, string> = {
  assignment: "Canvas 作业", announcement: "课程公告", page: "课程页面", quiz: "测验",
  discussion: "讨论", file: "课程文件", planner: "Canvas Planner", externaltool: "外部工具", externalurl: "外部链接",
  piazza: "Piazza", schedule: "个人日程",
};

const changeLabels: Record<string, string> = {
  dates_updated: "截止时间已调整",
  source_missing: "Canvas 中已移除，需确认是否取消",
  restored: "此前移除的内容已恢复",
  attachment_updated: "附件已更换",
  prerequisite_updated: "先修条件已变化",
};

export function DashboardShell({ displayName, timezone }: { displayName: string; timezone: string }) {
  const [completed, setCompleted] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [data, setData] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const date = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  const loadDashboard = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard?date=" + date);
      if (!response.ok) throw new Error("无法读取本地课程数据库");
      setData(await response.json()); setLoadError("");
    } catch (error) { setLoadError(error instanceof Error ? error.message : "读取失败"); }
    finally { setLoaded(true); }
  }, [date]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const visibleCourses = data?.courses?.length
    ? data.courses.map((course: any, index: number) => ({
        ...course,
        displayCode: presentCourse(course.code, course.name).displayCode,
        shortName: presentCourse(course.code, course.name).courseTitle,
        color: ["#315e53", "#a25544", "#60756e", "#567386", "#a7833d"][index % 5],
        count: data.tasks.filter((task: any) => task.courseId === course.id && task.localStatus === "active" && task.urgency !== "review" && !["completed", "locked", "not_open", "possibly_superseded"].includes(task.canvasStatus)).length,
        weekCount: data.tasks.filter((task: any) => task.courseId === course.id && task.localStatus === "active" && task.canvasStatus !== "completed" && task.dueAt && new Date(task.dueAt).getTime() >= Date.now() && new Date(task.dueAt).getTime() <= Date.now() + 7 * 86400000).length,
      }))
    : [];
  const plannedTasks = data?.plan
    ? [...(data.plan.mustDo || []), ...(data.plan.shouldDo || []), ...(data.plan.review || [])]
    : (data?.tasks || []);
  const visibleTasks = plannedTasks.length
    ? [...new Map(plannedTasks.map((task: any) => [task.id, task])).values()].filter((task: any) => task.localStatus !== "ignored").slice(0, 12).map((task: any) => ({
        id: task.id,
        course: presentCourse(task.courseCode || "", task.courseName || task.courseCode || "").displayCode,
        title: conciseTaskAction(task),
        originalTitle: task.title,
        detail: conciseRequirement(task),
        action: task.action,
        requirements: task.requirements || [],
        evidence: task.evidence,
        due: task.dueAt ? new Date(task.dueAt).toLocaleString("zh-CN", { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "需要确认",
        tone: task.urgency,
        source: sourceLabels[task.sourceType] || task.sourceType,
        sourceUrl: task.sourceUrl,
        confidence: task.confidence === "certain" ? "确定" : (task.analysisStatus === "complete" ? "AI 推断" : "规则推断"),
        localStatus: task.localStatus,
        canvasStatus: task.canvasStatus,
        prerequisiteBlocked: task.prerequisiteBlocked,
        estimatedMinutes: task.estimatedMinutes,
        updatedAt: task.updatedAt,
      }))
    : [];
  const estimatedMinutes = data?.plan?.scheduledMinutes ?? visibleTasks
    .filter((task: any) => task.tone !== "review" && !(completed.includes(task.id) || task.localStatus === "completed"))
    .reduce((total: number, task: any) => total + (task.estimatedMinutes || 45), 0);
  const loadPercent = Math.min(100, Math.round((estimatedMinutes / (data?.settings?.dailyMinutes || 150)) * 100));
  const urgentCount = visibleTasks.filter((task: any) => task.tone === "urgent").length;
  const reviewCount = visibleTasks.filter((task: any) => task.tone === "review").length;
  const meaningfulChangeTypes = new Set(["dates_updated", "source_missing", "restored", "attachment_updated", "prerequisite_updated"]);
  const recentChanges = data?.changes?.length ? data.changes.filter((change: any) => meaningfulChangeTypes.has(change.type)).slice(0, 3) : [];
  const scheduledCount = (data?.plan?.mustDo?.length || 0) + (data?.plan?.shouldDo?.length || 0);
  const mustMinutes = visibleTasks.filter((task: any) => ["urgent", "soon"].includes(task.tone) && task.localStatus !== "completed").reduce((sum: number, task: any) => sum + (task.estimatedMinutes || 45), 0);
  const advanceMinutes = visibleTasks.filter((task: any) => task.tone === "upcoming" && task.localStatus !== "completed").reduce((sum: number, task: any) => sum + (task.estimatedMinutes || 45), 0);
  const remainingCapacity = Math.max(0, (data?.settings?.dailyMinutes || 150) - estimatedMinutes);
  const overdueCount = (data?.tasks || []).filter((task: any) => task.localStatus === "active" && task.canvasStatus === "overdue_open").length;
  const nextCount = (data?.tasks || []).filter((task: any) => task.localStatus === "active" && (task.prerequisiteBlocked || ["locked", "not_open"].includes(task.canvasStatus))).length;
  const nextDeadline = visibleTasks.filter((task: any) => task.tone !== "review" && task.due !== "需要确认" && task.localStatus !== "completed")[0];
  const loadAssessment = loadPercent > 100 ? "已超出今日容量，先保截止任务" : loadPercent >= 80 ? "负荷偏满，暂缓新增任务" : loadPercent >= 50 ? "负荷适中，仍可安排推进" : "负荷较轻，可提前推进";
  const coursesDueSoon = visibleCourses.filter((course: any) => course.weekCount > 0).sort((a: any, b: any) => b.weekCount - a.weekCount).slice(0, 8);
  const taskGroups = [
    { key: "must", title: "必须完成", note: "截止时间或提交状态明确", tasks: visibleTasks.filter((task: any) => ["urgent", "soon"].includes(task.tone)) },
    { key: "advance", title: "建议推进", note: "按优先分数排入今天容量", tasks: visibleTasks.filter((task: any) => task.tone === "upcoming") },
    { key: "review", title: "需要确认", note: "日期不明确、已锁定或长期逾期", tasks: visibleTasks.filter((task: any) => task.tone === "review") },
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
    if (data?.tasks?.length) {
      setSyncMessage(done ? "正在恢复 Canvas To-do…" : "正在勾选 Canvas To-do…");
      const response = await fetch("/api/tasks/" + encodeURIComponent(task.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: done ? "active" : "completed", syncCanvas: true }),
      });
      const result = await response.json();
      if (!response.ok) setSyncMessage(result.error === "CANVAS_PLANNER_WRITE_FORBIDDEN" ? "Canvas 不允许修改这项 To-do，本站未作更改" : "Canvas To-do 同步失败，本站未作更改");
      else {
        setCompleted((items) => done ? items.filter((id) => id !== task.id) : [...items, task.id]);
        setSyncMessage(!result.canvas?.supported ? "这类内容没有 Canvas To-do 勾选项，已仅在本站标记" : done ? "已同步恢复 Canvas To-do" : "已同步完成 Canvas To-do");
      }
      await loadDashboard();
    }
  }

  return (
    <SidebarProvider>
      <Sidebar className="border-r-0 bg-[linear-gradient(90deg,rgba(31,47,43,.98),rgba(48,70,61,.90)),url('/assets/vic3-theme/header-pattern.png'),url('/assets/vic3-theme/sidebar-bg.png')] bg-[position:center,right_center,center_top] bg-[size:100%_100%,auto_100%,100%_auto] bg-no-repeat [background-blend-mode:normal,soft-light,normal]" variant="sidebar">
        <SidebarHeader className="px-3 pb-2 pt-3"><div className="sidebar-brand-plaque"><Landmark className="absolute left-[1.08rem] top-1/2 z-10 size-3.5 -translate-y-1/2 text-[#d8bd7d]" /><div><p className="font-serif font-semibold tracking-wide">Study Cabinet</p><p className="text-[10px] uppercase tracking-[.14em] text-sidebar-foreground/50">Personal observatory</p></div></div></SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="py-2"><SidebarGroupLabel>总控台</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{nav.map((item, index) => <SidebarMenuItem key={item.href}><SidebarMenuButton asChild isActive={index === 0} tooltip={item.label}><Link href={item.href}><item.icon /><span>{item.label}</span></Link></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
          <SidebarGroup className="py-2"><SidebarGroupLabel>本学期课程</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{visibleCourses.map((course: any) => <SidebarMenuItem key={course.code}><SidebarMenuButton asChild tooltip={course.name}><Link href={"/courses/" + course.id}><span className="course-tile" style={{ backgroundColor: course.color }} /><span>{course.displayCode}</span></Link></SidebarMenuButton><SidebarMenuBadge>{course.count}</SidebarMenuBadge></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-3 pb-3"><div className="sidebar-footer-plaque"><p className="truncate text-sm font-medium">{displayName}</p><p className="text-[10px] uppercase tracking-[.12em] text-sidebar-foreground/50">Private archive</p></div></SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0 bg-transparent">
        <header className="top-beam sticky top-0 z-30 flex h-16 items-center justify-between px-4 md:px-7"><div className="flex items-center gap-3"><SidebarTrigger className="md:hidden" /><div><p className="text-[9px] font-semibold uppercase tracking-[.17em] text-[#bca66f]">{timezone.replace("_", " ")}</p><p className="text-sm font-medium text-[#f3ecdd]">个人总览台</p></div></div><div className="flex items-center gap-2"><span className="hidden text-xs text-[#d7cbae] sm:inline">● 每 15 分钟同步</span><Button onClick={previewSync} disabled={syncing} variant="outline" className="border-[#9f8755] bg-[#eee5d2] text-[#273a34]" size="sm"><RefreshCw className={syncing ? "animate-spin" : ""} />{syncing ? "同步中" : "立即同步"}</Button></div></header>
        {syncMessage && <div aria-live="polite" className="border-b border-[#9b8151] bg-[#efe5ce] px-4 py-2 text-center text-xs text-[#5d5036]">{syncMessage}</div>}

        <main className="w-full px-3 py-4 sm:px-5 md:px-7 md:py-5 2xl:px-[clamp(2rem,3vw,6rem)]">
          <section className="grand-overview mb-5">
            <div className="relative z-10 grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(28rem,.8fr)] md:items-center md:px-6">
              <div><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="border-[#b79e66] bg-black/10 text-[#e5d8b8]">{!loaded ? "读取中" : data?.courses?.length ? (data.lastSync?.status === "complete" ? "Canvas 已同步" : "Canvas 准备就绪") : "等待首次同步"}</Badge>{data?.aiAvailable === false && <Badge variant="outline" className="border-amber-300/35 text-amber-100">AI 未配置</Badge>}</div><h1 className="mt-2 text-2xl font-semibold text-[#fff8e8] sm:text-3xl">{displayName} 的今日简报</h1><p className="mt-1 text-sm text-white/62">优先 {visibleTasks.filter((task: any) => ["urgent", "soon"].includes(task.tone)).length} 项 · 待核对 {reviewCount} 项 · 可用课程 {visibleCourses.length} 门</p></div>
              <div className="overview-ledger grid grid-cols-2 divide-x divide-y md:grid-cols-4 md:divide-y-0"><div><b>{nextDeadline?.due || "—"}</b><span>下一截止</span></div><div><b>{estimatedMinutes}m</b><span>今日投入</span></div><div><b>{overdueCount}</b><span>逾期可交</span></div><div><b>{visibleTasks.filter((task: any) => completed.includes(task.id) || task.localStatus === "completed").length}</b><span>今日完成</span></div></div>
            </div>
          </section>

          {loadError && <section className="mb-5 border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</section>}
          {loaded && !loadError && visibleCourses.length === 0 && <section className="parchment-panel mb-5 p-5"><p className="section-kicker">FIRST SYNC</p><h2 className="text-xl font-semibold">把 Quercus 课程读进本地数据库</h2><p className="mt-2 text-sm text-muted-foreground">读取课程、公告、Modules、作业、截止日期和提交状态；Token 仅留在服务器。</p><Button onClick={previewSync} disabled={syncing} className="mt-4"><RefreshCw className={syncing ? "animate-spin" : ""} />开始同步</Button></section>}
          {loaded && !loadError && visibleCourses.length > 0 && <div id="global-search" className="scroll-mt-20"><CourseAssistant courses={visibleCourses.map((course: {id:string;code:string})=>({id:course.id,code:course.code}))} /></div>}

          <div id="learning" className="grid scroll-mt-20 grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(330px,24%)]">
            <section className="min-w-0 space-y-4" aria-labelledby="must-do-title">
              <div className="ornate-section-heading flex items-center justify-between">
                <div><p className="section-kicker">ACTION QUEUE</p><h2 id="must-do-title" className="text-xl font-semibold">现在要做</h2></div>
                <span className="text-sm text-muted-foreground">{visibleTasks.filter((task: any) => completed.includes(task.id) || task.localStatus === "completed").length}/{visibleTasks.length} 完成</span>
              </div>
              <div className="status-ledger-frame grid gap-px rounded-2xl border bg-border sm:grid-cols-3">
                <div className="bg-card p-3"><p className="text-[11px] font-semibold text-muted-foreground">下一个截止</p><p className="mt-1 truncate text-sm font-semibold">{nextDeadline ? `${nextDeadline.course} · ${nextDeadline.due}` : "暂无确定截止"}</p></div>
                <div className="bg-card p-3"><p className="text-[11px] font-semibold text-muted-foreground">今日投入</p><p className="mt-1 text-sm font-semibold">{estimatedMinutes} 分钟 · {scheduledCount} 项</p></div>
                <div className="bg-card p-3"><p className="text-[11px] font-semibold text-muted-foreground">阻塞与逾期</p><p className={`mt-1 text-sm font-semibold ${overdueCount + nextCount ? "text-amber-700" : "text-emerald-700"}`}>{overdueCount} 项逾期 · {nextCount} 项受限</p></div>
              </div>
              {taskGroups.map((group) => group.tasks.length ? <details key={group.key} open={group.key !== "review"} className={`group/list ledger-group ledger-${group.key} min-w-0 overflow-hidden border bg-card`}><summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5"><div><h3 className="text-sm font-semibold after:ml-1 after:text-primary after:content-['＋'] group-open/list:after:content-['－']">{group.title}</h3><p className="mt-0.5 text-xs text-muted-foreground">{group.note}</p></div><Badge variant="secondary">{group.tasks.length} 项</Badge></summary><div className="divide-y">{group.tasks.map((task: any) => {
                const done = completed.includes(task.id) || task.localStatus === "completed";
                const reason = task.canvasStatus === "overdue_open" ? "已逾期，仍可提交" : task.prerequisiteBlocked ? "被先修条件阻塞" : task.tone === "urgent" ? "今天必须处理" : task.tone === "soon" ? "截止时间接近" : task.tone === "review" ? "信息需要确认" : "可提前推进";
                return (
                  <article key={task.id} className={`flex min-w-0 gap-3 border-l-4 p-4 ${task.tone === "urgent" ? "border-l-rose-500" : task.tone === "soon" ? "border-l-amber-400" : task.tone === "review" ? "border-l-sky-400" : "border-l-emerald-400"} ${done ? "opacity-55" : ""}`}>
                    <button
                      className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-2 border-muted-foreground/45 text-primary transition hover:scale-105 hover:border-primary"
                      aria-label={done ? "恢复 " + task.title : "完成 " + task.title}
                      onClick={() => void toggleTask(task, done)}
                    >{done && <Check className="size-4" />}</button>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary" className="max-w-40 truncate">{task.course}</Badge><span className="text-xs font-medium text-muted-foreground">{reason}</span></div><h3 className={`mt-1.5 text-[15px] font-semibold leading-5 ${done ? "line-through" : ""}`}>{task.title}</h3></div>
                        <div className="flex shrink-0 items-center gap-2 text-xs sm:flex-col sm:items-end sm:gap-1"><span className="font-semibold text-foreground">{task.due}</span><span className="text-muted-foreground">约 {task.estimatedMinutes || 45} 分钟</span></div>
                      </div>
                      <p className="mt-1.5 truncate text-xs text-muted-foreground">{task.detail}</p>
                      <details className="group mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer list-none font-medium text-primary after:ml-1 after:content-['＋'] group-open:after:content-['－']">要求与依据</summary>
                        <div className="mt-2 space-y-2 rounded-xl bg-muted/55 p-3 leading-5">
                          <p className="font-medium text-foreground">Canvas 项目：{task.originalTitle}</p>
                          {task.requirements.length > 0 && <ul className="list-disc space-y-1 pl-5">{task.requirements.slice(0, 4).map((item: string) => <li key={item}>{item}</li>)}</ul>}
                          {task.evidence && <p>依据：{task.evidence}</p>}
                          <p className="text-xs">来源：{task.source} · 更新于 {new Date(task.updatedAt).toLocaleString("zh-CN", { timeZone: timezone })}</p>
                          {task.sourceUrl && <a href={task.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex font-medium text-primary hover:underline">打开 Canvas 原文</a>}
                        </div>
                      </details>
                    </div>
                  </article>
                );
              })}</div></details> : null)}
              {loaded && visibleTasks.length === 0 && visibleCourses.length > 0 && <div className="rounded-3xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">当前没有未忽略的任务。你可以进入课程页查看所有已读取内容。</div>}
              {loaded && !loadError && <DueDayList tasks={data?.tasks || []} timezone={timezone} />}
              <AiUsagePanel />
            </section>

            <aside className="space-y-5">
              <section className="instrument-panel instrument-burgundy p-5">
                <div className="relative flex items-center justify-between border-b border-[#bca064]/30 pb-3"><div><p className="text-[10px] font-semibold uppercase tracking-[.17em] text-[#c6aa6b]">DAILY CAPACITY</p><h2 className="mt-0.5 text-lg font-semibold">学习负荷</h2></div><Clock3 className="size-4 text-[#d2b978]" /></div>
                <div className="relative mt-4 flex items-end justify-between"><div><span className="text-3xl font-semibold">{Math.floor(estimatedMinutes / 60)}h {estimatedMinutes % 60}m</span><p className="mt-1 text-xs text-white/55">容量 {data?.settings?.dailyMinutes || 150} 分钟</p></div><span className="border border-white/15 bg-black/10 px-2 py-1 text-xs text-[#dbc487]">{loadPercent}%</span></div>
                <Progress value={loadPercent} className="relative mt-3 h-1.5 bg-black/25 [&>div]:bg-[#bda15f]" />
                <p className="relative mt-3 text-sm font-medium text-[#ece4d2]">{loadAssessment}</p>
                <div className="mt-5 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between"><span className="text-white/55">保截止任务</span><span className="font-semibold">{mustMinutes} 分钟</span></div>
                  <div className="flex items-center justify-between"><span className="text-white/55">提前推进</span><span className="font-semibold">{advanceMinutes} 分钟</span></div>
                  <div className="flex items-center justify-between border-t border-white/10 pt-2.5"><span className="text-white/55">尚可安排</span><span className="font-semibold text-emerald-300">{remainingCapacity} 分钟</span></div>
                </div>
                <div className="relative mt-4 grid grid-cols-3 divide-x divide-white/10 border border-white/10 bg-black/10 py-2.5 text-center text-xs text-white/55"><div><b className="block text-base text-white">{urgentCount}</b>紧急</div><div><b className="block text-base text-white">{overdueCount}</b>逾期可交</div><div><b className="block text-base text-white">{reviewCount}</b>待确认</div></div>
              </section>

              <section className="parchment-panel p-5">
                <div className="flex items-center gap-2 border-b border-[#b8a77f] pb-3"><AlertTriangle className="size-4 text-[#9a533d]" /><div><p className="font-semibold">最近变更</p><p className="text-xs text-muted-foreground">{data?.lastSync ? "同步于 " + new Date(data.lastSync.finishedAt || data.lastSync.startedAt).toLocaleString("zh-CN", { timeZone: timezone }) : "上次检查：尚未同步"}</p></div></div>
                <div className="mt-5 space-y-4">
                  {recentChanges.map((change: any) => (
                    <div key={change.id} className={`border-l-2 ${change.type === "dates_updated" ? "border-rose-400" : change.type === "source_missing" ? "border-amber-400" : "border-sky-400"} pl-4`}>
                      <p className="text-xs font-semibold text-muted-foreground">{change.courseCode} · {changeLabels[change.type] || "影响计划的变化"}</p>
                      <p className="mt-1 text-sm font-medium leading-5">{change.title}</p>
                    </div>
                  ))}
                  {recentChanges.length === 0 && <p className="text-sm leading-6 text-muted-foreground">最近没有会影响截止时间或任务有效性的变化。普通文本改动已自动隐藏。</p>}
                </div>
                <Button asChild variant="outline" className="mt-5 w-full rounded-xl"><Link href="/changes">查看所有变更</Link></Button>
              </section>

              <section className="rounded-3xl border bg-card p-6 shadow-sm">
                <div className="flex items-center gap-2"><CalendarDays className="size-4 text-primary" /><h2 className="font-semibold">未来 7 天</h2></div>
                <div className="mt-5 space-y-4">
                  {coursesDueSoon.map((course: any, index: number) => (
                    <Link href={"/courses/" + course.id} key={course.id} className="group flex items-center gap-3">
                      <span className="course-tile size-9" style={{ backgroundColor: course.color }}><b className="text-xs text-white drop-shadow">{index + 1}</b></span>
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{course.displayCode}</p><p className="truncate text-xs text-muted-foreground">{course.shortName}</p></div>
                      <span className="text-sm font-semibold">{course.weekCount}</span>
                    </Link>
                  ))}
                  {coursesDueSoon.length === 0 && <p className="text-sm text-muted-foreground">未来 7 天没有确定截止事项。</p>}
                </div>
              </section>
              <ShortcutPanel />
            </aside>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
