"use client";

import { FormEvent, useEffect, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Source = { ref: string; title: string; courseCode: string; url: string | null };
type Point = { text: string; refs: string[]; category: "update" | "answer" | "open" };
type Report = { weekStart: string; weekEnd: string; timezone: string; postCount: number; points: Point[]; sources: Source[]; generatedAt: string };
type Week = { weekStart: string; weekEnd: string; postCount: number; answered: number; report: Report | null };
type Answer = { answer: string; sources: Source[]; supported: boolean };

export function PiazzaAiPanel() {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [questionWeek, setQuestionWeek] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);

  async function load() {
    const response = await fetch("/api/piazza/ai/summary", { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "无法读取每周总结");
    setWeeks(value.weeks);
    setLoading(false);
  }
  useEffect(() => { void load().catch(e => { setError(e.message); setLoading(false); }); }, []);

  async function generate(starts: string[]) {
    if (!starts.length || running) return;
    setRunning(true); setError("");
    const failures: string[] = [];
    try {
      for (let index = 0; index < starts.length; index++) {
        const start = starts[index];
        setProgress(`正在总结第 ${index + 1}/${starts.length} 周：${start}`);
        try {
          const response = await fetch("/api/piazza/ai/summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weekStart: start }) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || "生成失败");
          setWeeks(current => current.map(week => week.weekStart === start ? { ...week, report: value.report } : week));
        } catch (e) {
          failures.push(`${start}：${e instanceof Error ? e.message : "生成失败"}`);
          if (/配置 AI 服务|预算不足/.test(failures.at(-1) || "")) break;
        }
      }
      setProgress(failures.length ? "部分周未完成" : "所有周的 AI 总结已更新");
      if (failures.length) setError(failures.join("；"));
    } finally { setRunning(false); }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || asking) return;
    setAsking(true); setError(""); setAnswer(null);
    try {
      const response = await fetch("/api/piazza/ai/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, weekStart: questionWeek }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "AI 问答失败");
      setAnswer(value);
    } catch (e) { setError(e instanceof Error ? e.message : "AI 问答失败"); }
    finally { setAsking(false); }
  }

  return <div className="space-y-6">
    <section className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="size-5" />AI 全部总结</h2><p className="mt-1 text-sm text-muted-foreground">覆盖所有已归档 Piazza 帖子，按周一至周日分段。每条结论附原帖；没有被 AI 提及的帖子也会列入该周，避免遗漏。</p></div><Button onClick={() => void generate(weeks.filter(week => !week.report).map(week => week.weekStart))} disabled={running || loading || !weeks.some(week => !week.report)}>{running ? "生成中…" : "生成全部每周总结"}</Button></div>
      {progress && <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">{progress}</p>}
      {loading && <p className="mt-4 text-sm text-muted-foreground">正在读取归档周次…</p>}
      {!loading && weeks.length === 0 && <p className="mt-4 text-sm text-muted-foreground">暂无已归档的 Piazza 帖子。</p>}
    </section>
    {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <section className="rounded-2xl border bg-card p-5"><h2 className="text-lg font-semibold">AI 问答</h2>
      <form onSubmit={ask} className="mt-4 flex flex-wrap gap-2"><Input aria-label="向 Piazza 归档提问" className="min-w-56 flex-1" maxLength={1000} placeholder="例如：这周实验需要准备什么？" value={question} onChange={e => setQuestion(e.target.value)} /><select aria-label="问答时间范围" className="rounded-md border bg-background px-3 text-sm" value={questionWeek} onChange={e => setQuestionWeek(e.target.value)}><option value="">全部归档</option>{weeks.map(week => <option key={week.weekStart} value={week.weekStart}>{week.weekStart} 至 {week.weekEnd}</option>)}</select><Button type="submit" disabled={asking || !question.trim()}>{asking ? "查找中…" : "提问"}</Button></form>
      {answer && <div className="mt-4 rounded-xl bg-muted/40 p-4"><p className="whitespace-pre-wrap text-sm leading-7">{answer.answer}</p>{answer.sources.length > 0 && <div className="mt-4 border-t pt-3"><p className="mb-2 text-xs font-semibold text-muted-foreground">引用原帖</p><div className="flex flex-wrap gap-2">{answer.sources.map(source => source.url ? <a key={source.ref} href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs text-primary hover:underline">[{source.ref}] {source.courseCode} · {source.title}<ExternalLink className="size-3" /></a> : <span key={source.ref} className="rounded-md border bg-card px-2 py-1 text-xs">[{source.ref}] {source.courseCode} · {source.title}</span>)}</div></div>}</div>}
    </section>
    <div className="space-y-4">{weeks.map(week => <section key={week.weekStart} className="rounded-2xl border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{week.weekStart} 至 {week.weekEnd}</h2><p className="mt-1 text-xs text-muted-foreground">{week.postCount} 条帖子 · {week.answered} 条教师回答</p></div>{!week.report && <Button variant="outline" disabled={running} onClick={() => void generate([week.weekStart])}>生成这周总结</Button>}</div>{week.report ? <div className="mt-4 space-y-3">{week.report.points.map((point, index) => <div key={index} className="border-l-2 border-primary/40 pl-3"><p className="text-sm leading-6"><span className="mr-2 text-xs font-medium text-muted-foreground">{point.category === "answer" ? "确定回答" : point.category === "open" ? "待解问题" : "课程消息"}</span>{point.text}</p><div className="mt-1 flex flex-wrap gap-2">{point.refs.map(ref => { const source = week.report!.sources.find(item => item.ref === ref); return source?.url ? <a key={ref} href={source.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline-offset-2 hover:underline">[{ref}] {source.courseCode} · {source.title}</a> : <span key={ref} className="text-xs text-muted-foreground">[{ref}] {source?.title || "原帖"}</span>; })}</div></div>)}<p className="pt-2 text-xs text-muted-foreground">分析了该周全部 {week.report.postCount} 条帖子 · 更新于 {new Date(week.report.generatedAt).toLocaleString("zh-CN")}</p></div> : <p className="mt-4 text-sm text-muted-foreground">这一周尚未生成 AI 总结。</p>}</section>)}</div>
  </div>;
}
