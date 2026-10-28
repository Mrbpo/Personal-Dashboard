"use client";

import { useMemo, useState } from "react";
import { Bell, BookOpen, ExternalLink, FileText, FlaskConical, MessageSquareText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type CourseSourceDetail = {
  id: string; type: string; title: string; body: string; excerpt: string; url: string | null;
  updatedAt: string | null; analysisStatus: string; dates: Record<string, string | number | boolean | null>; active: boolean;
};

const labels: Record<string, string> = { announcement: "公告", module: "模块", assignment: "作业", page: "课程页面", quiz: "测验", discussion: "讨论", file: "文件", planner: "计划", subheader: "章节", piazza: "Piazza", externalurl: "外部链接", externaltool: "外部工具" };
const tabTypes: Record<string, string[]> = {
  modules: ["module", "subheader", "page", "file", "externalurl", "externaltool"],
  work: ["assignment", "quiz", "planner"],
  announcements: ["announcement", "discussion"],
  piazza: ["piazza"],
  all: [],
};

function formatDate(value: unknown, timezone: string) {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function moduleName(source: CourseSourceDetail) {
  return source.body.match(/^所属 Module：([^\n]+)/m)?.[1]?.trim() || (source.type === "module" ? source.title : "其他课程资料");
}

function readableBody(source: CourseSourceDetail) {
  return source.body.replace(/^所属 Module：[^\n]+\n?/m, "").trim();
}

export function CourseLibrary({ sources, timezone }: { sources: CourseSourceDetail[]; timezone: string }) {
  const [tab, setTab] = useState("modules");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const activeSources = useMemo(() => sources.filter((source) => source.active), [sources]);
  const counts = useMemo(() => Object.fromEntries(Object.entries(tabTypes).map(([key, types]) => [key, types.length ? activeSources.filter((source) => types.includes(source.type)).length : activeSources.length])), [activeSources]);
  const filtered = useMemo(() => {
    const types = tabTypes[tab];
    const needle = query.trim().toLocaleLowerCase();
    return activeSources
      .filter((source) => (!types.length || types.includes(source.type)) && (!needle || `${source.title} ${source.body}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => {
        if (tab === "modules") return moduleName(a).localeCompare(moduleName(b), undefined, { numeric: true }) || a.title.localeCompare(b.title, undefined, { numeric: true });
        return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      });
  }, [activeSources, query, tab]);
  const selected = filtered.find((source) => source.id === selectedId) || filtered[0];

  return (
    <section className="archive-shelf overflow-hidden rounded-3xl border bg-card shadow-sm" aria-labelledby="course-library-title">
      <div className="archive-shelf-heading border-b p-5 md:p-6">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div><p className="section-kicker">COURSE LIBRARY</p><h2 id="course-library-title" className="text-xl font-semibold md:text-2xl">课程资料与详细要求</h2></div>
          <div className="relative w-full lg:max-w-sm"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedId(""); }} placeholder="搜索实验、notebook、作业要求…" className="h-11 rounded-xl pl-9" /></div>
        </div>
        <Tabs value={tab} onValueChange={(value) => { setTab(value); setSelectedId(""); }} className="mt-5">
          <TabsList variant="line" className="grid h-auto w-full grid-cols-2 justify-start gap-y-2 sm:flex sm:w-fit sm:max-w-full sm:flex-nowrap sm:overflow-x-auto">
            <TabsTrigger value="modules"><BookOpen />Modules <span className="text-xs text-muted-foreground">{counts.modules}</span></TabsTrigger>
            <TabsTrigger value="work"><FlaskConical />作业与测验 <span className="text-xs text-muted-foreground">{counts.work}</span></TabsTrigger>
            <TabsTrigger value="announcements"><Bell />公告 <span className="text-xs text-muted-foreground">{counts.announcements}</span></TabsTrigger>
            <TabsTrigger value="piazza"><MessageSquareText />Piazza <span className="text-xs text-muted-foreground">{counts.piazza}</span></TabsTrigger>
            <TabsTrigger value="all"><FileText />全部 <span className="text-xs text-muted-foreground">{counts.all}</span></TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {filtered.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">没有找到符合条件的课程资料。</div> : (
        <div className="grid min-h-[34rem] lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
          <div className="border-b bg-muted/25 lg:border-b-0 lg:border-r">
            <div className="max-h-[18rem] overflow-y-auto p-2 md:p-3 lg:max-h-[34rem]">
              {filtered.map((source, index) => {
                const current = selected?.id === source.id;
                const group = tab === "modules" ? moduleName(source) : "";
                const previousGroup = index ? moduleName(filtered[index - 1]) : "";
                return <div key={source.id}>{tab === "modules" && group !== previousGroup && <p className="break-words px-3 pb-1 pt-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">{group}</p>}<button onClick={() => setSelectedId(source.id)} className={`mb-1 w-full overflow-hidden rounded-xl px-3 py-3 text-left transition ${current ? "bg-white shadow-sm ring-1 ring-indigo-200" : "hover:bg-white/70"}`}><div className="flex min-w-0 items-start justify-between gap-2"><p className="min-w-0 flex-1 break-all text-sm font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{source.title}</p><span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{labels[source.type] || source.type}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">{source.excerpt || "无文字说明，打开原文查看"}</p></button></div>;
              })}
            </div>
          </div>
          {selected && <article className="min-w-0 p-5 md:p-7">
            <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{labels[selected.type] || selected.type}</Badge>{selected.analysisStatus === "complete" && <Badge variant="outline">AI 已分析</Badge>}{selected.analysisStatus === "imported" && <Badge variant="outline">已同步</Badge>}</div>
            <h3 className="mt-4 text-xl font-semibold leading-tight [overflow-wrap:anywhere] md:text-2xl">{selected.title}</h3>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
              {selected.updatedAt && <span>更新于 {formatDate(selected.updatedAt, timezone)}</span>}
              {selected.dates?.dueAt && <span className="font-medium text-rose-600">截止 {formatDate(selected.dates.dueAt, timezone)}</span>}
              {selected.dates?.unlockAt && <span>开放 {formatDate(selected.dates.unlockAt, timezone)}</span>}
              {selected.dates?.lockAt && <span>关闭 {formatDate(selected.dates.lockAt, timezone)}</span>}
            </div>
            <div className="mt-6 rounded-2xl border bg-background p-4 md:p-6"><p className="mb-3 flex items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-indigo-500" />同步到的完整内容</p>{tab === "modules" && moduleName(selected) !== selected.title && <p className="mb-3 text-xs font-medium text-indigo-600">所属 Module：{moduleName(selected)}</p>}<div className="whitespace-pre-wrap text-[15px] leading-7 text-foreground/80 [overflow-wrap:anywhere]">{readableBody(selected) || "Canvas 没有提供文字说明。请打开原文查看附件、题目或互动内容。"}</div></div>
            {selected.url && <a href={selected.url} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"><ExternalLink className="size-4" />{selected.type === "piazza" ? "打开 Piazza 原帖" : "打开 Canvas 原文"}</a>}
          </article>}
        </div>
      )}
    </section>
  );
}
