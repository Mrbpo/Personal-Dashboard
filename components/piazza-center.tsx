"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PiazzaAiPanel } from "@/components/piazza-ai-panel";

type Post = { id: string; courseId: string; courseCode: string; title: string; body: string; answer: string; kind: string; url: string | null; updatedAt: string | null };
type Daily = { date: string; timezone: string; total: number; answered: number; recentDates: string[]; courses: { code: string; total: number; answered: number; notes: number; headlines: { id: string; title: string; excerpt: string; answer: string; kind: string }[] }[]; posts: Post[]; generatedAt: string };
type Answers = { total: number; items: Post[]; nextOffset: number | null };
type Status = { connected: boolean; status: string; classes: { nid: string; courseId?: string; courseCode?: string }[]; lastSyncedAt: string | null; postCount: number; error: string | null };

function PostCard({ post, showAnswer = true }: { post: Post; showAnswer?: boolean }) {
  return <article className="rounded-2xl border bg-card p-4 shadow-sm">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="rounded-md bg-primary/10 px-2 py-1 font-medium text-primary">{post.courseCode}</span><span>{post.kind === "question" ? "问答" : "消息"}</span>{post.updatedAt && <time>{new Date(post.updatedAt).toLocaleString("zh-CN")}</time>}</div>
    <h3 className="mt-3 break-words text-base font-semibold">{post.title}</h3>
    {showAnswer && post.answer && <div className="mt-3 rounded-xl border border-emerald-300/50 bg-emerald-50/60 p-3"><p className="text-xs font-semibold text-emerald-800">教师明确回答</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{post.answer}</p></div>}
    <details className="mt-3"><summary className="cursor-pointer text-sm text-primary">查看完整帖子与回复</summary><p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 text-sm leading-6">{post.body || "原帖没有可读取的正文，请打开 Piazza 查看。"}</p></details>
    {post.url && <a className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline" href={post.url} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" />打开 Piazza 原帖</a>}
  </article>;
}

export function PiazzaCenter({ initialStatus }: { initialStatus: Status }) {
  const [tab, setTab] = useState<"daily" | "answers" | "ai">("daily");
  const [date, setDate] = useState("");
  const [daily, setDaily] = useState<Daily | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [courseId, setCourseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(initialStatus);

  const loadDaily = useCallback(async (chosenDate: string) => {
    const response = await fetch(`/api/piazza/daily${chosenDate ? `?date=${encodeURIComponent(chosenDate)}` : ""}`, { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "摘要读取失败");
    setDaily(value); setDate(value.date);
  }, []);
  const loadAnswers = useCallback(async (q: string, selectedCourse: string, offset = 0) => {
    const params = new URLSearchParams({ q, courseId: selectedCourse, offset: String(offset) });
    const response = await fetch(`/api/piazza/answers?${params}`, { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "问答读取失败");
    setAnswers(previous => offset && previous ? { ...value, items: [...previous.items, ...value.items] } : value);
  }, []);
  useEffect(() => { void loadDaily("").catch(e => setError(e.message)); void loadAnswers("", "").catch(e => setError(e.message)); }, [loadDaily, loadAnswers]);

  async function sync() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/piazza/sync", { method: "POST" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "同步失败");
      await Promise.all([loadDaily(date), loadAnswers(submittedQuery, courseId)]);
      const statusResponse = await fetch("/api/piazza/status", { cache: "no-store" });
      if (statusResponse.ok) setStatus(await statusResponse.json());
    } catch (e) { setError(e instanceof Error ? e.message : "同步失败"); }
    finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-4 text-sm">
      <div><p className="font-semibold">已归档 {status.postCount} 条帖子</p><p className="mt-1 text-xs text-muted-foreground">{status.lastSyncedAt ? `上次同步：${new Date(status.lastSyncedAt).toLocaleString("zh-CN")}` : "尚未同步"} · 摘要按网站时区逐日生成；历史帖子正在分批补齐。</p></div>
      <div className="flex gap-2"><Button variant="outline" asChild><Link href="/settings">连接设置</Link></Button>{status.connected && <Button onClick={sync} disabled={busy}><RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />{busy ? "同步中…" : "立即同步"}</Button>}</div>
    </section>
    {status.status === "needs_reconnect" && <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Piazza 登录已失效。历史归档仍可查看；请到<Link className="mx-1 font-semibold underline" href="/settings">设置</Link>重新连接，以继续同步并识别旧帖中的教师回答。</p>}
    {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button variant={tab === "daily" ? "default" : "outline"} onClick={() => setTab("daily")}>每日消息</Button><Button variant={tab === "ai" ? "default" : "outline"} onClick={() => setTab("ai")}>AI 每周总结与问答</Button><Button variant={tab === "answers" ? "default" : "outline"} onClick={() => setTab("answers")}>已确认问答列表</Button></div>
    {tab === "ai" ? <PiazzaAiPanel /> : tab === "daily" ? <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3"><label className="text-sm font-medium">查看日期<Input className="mt-1 w-44" type="date" value={date} onChange={e => { setDate(e.target.value); void loadDaily(e.target.value).catch(error => setError(error.message)); }} /></label><span className="pb-2 text-xs text-muted-foreground">{daily?.timezone || "America/Toronto"}</span></div>
      {daily?.recentDates?.length ? <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">最近有更新：</span>{daily.recentDates.slice(0, 8).map(day => <button key={day} className="rounded-md border bg-card px-2 py-1 hover:bg-muted" onClick={() => void loadDaily(day).catch(error => setError(error.message))}>{day}</button>)}</div> : null}
      {daily && <><section className="rounded-2xl border bg-card p-5"><h2 className="text-lg font-semibold">{daily.date} 的 Piazza 摘要</h2><p className="mt-1 text-sm text-muted-foreground">{daily.total} 条更新 · {daily.answered} 条有教师明确回答 · {daily.courses.length} 门课程</p>{daily.courses.map(course => <div key={course.code} className="mt-4 border-t pt-4"><h3 className="font-semibold">{course.code} <span className="text-sm font-normal text-muted-foreground">{course.total} 条消息，{course.answered} 条已回答</span></h3><ul className="mt-2 space-y-2 text-sm">{course.headlines.map(item => <li key={item.id}><span className="font-medium">{item.kind === "question" ? "问：" : "消息："}{item.title}</span>{item.answer ? <p className="mt-0.5 line-clamp-2 text-muted-foreground">答：{item.answer}</p> : item.excerpt && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{item.excerpt}</p>}</li>)}</ul></div>)}{daily.total === 0 && <p className="mt-4 text-sm text-muted-foreground">这一天没有已同步的 Piazza 更新。若课程尚未完成历史补存，可稍后再次同步。</p>}</section><section><h2 className="mb-3 text-lg font-semibold">当天全部消息</h2><div className="grid gap-3">{daily.posts.map(post => <PostCard key={post.id} post={post} />)}</div></section></>}
    </div> : <div className="space-y-4">
      <p className="text-sm text-muted-foreground">这里只列出 Piazza 明确标记的教师回答。学生回复、未回答的问题和普通消息不会当作确切答案。</p>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setSubmittedQuery(query); void loadAnswers(query, courseId).catch(e => setError(e.message)); }}><Input aria-label="搜索问题或答案" className="min-w-56 flex-1" placeholder="搜索问题、正文或答案" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="筛选课程" className="rounded-md border bg-background px-3 text-sm" value={courseId} onChange={e => { setCourseId(e.target.value); void loadAnswers(submittedQuery, e.target.value).catch(error => setError(error.message)); }}><option value="">全部课程</option>{status.classes.filter(c => c.courseId).map(c => <option key={c.nid} value={c.courseId}>{c.courseCode}</option>)}</select><Button type="submit"><Search className="size-4" />搜索</Button></form>
      <p className="text-sm text-muted-foreground">找到 {answers?.total ?? 0} 条确切问答</p>
      <div className="grid gap-3">{answers?.items.map(post => <PostCard key={post.id} post={post} />)}</div>
      {answers?.nextOffset != null && <Button variant="outline" onClick={() => void loadAnswers(submittedQuery, courseId, answers.nextOffset!).catch(e => setError(e.message))}>加载更多</Button>}
      {answers?.total === 0 && <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">暂无符合条件的教师回答。已归档的旧帖子需要在后续同步中重新读取，才能识别回答类型。</p>}
    </div>}
  </div>;
}
