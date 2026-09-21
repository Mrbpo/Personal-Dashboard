"use client";

import { FormEvent, useState } from "react";
import { ArrowUp, BookOpen, LibraryBig, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MiniAiFeedback } from '@/components/mini-ai-feedback';

type Citation = {
  ref: string;
  courseCode: string;
  sourceType: string;
  title: string;
  excerpt: string;
  sourceUrl: string | null;
};

type Answer = {
  coverage?: string;
  answer: string;
  needsClarification: boolean;
  followUps: string[];
  citations: Citation[];
  aiAvailable: boolean;
  feedbackId: string;
};

const examples = ["帮我总结一下 CHMA10 Piazza", "第一节 Lab 的课前 notebook 怎么做？", "老师最近改了哪些要求？"];

export function CourseAssistant() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState("");

  async function ask(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const value = (preset ?? question).trim();
    if (!value || loading) return;
    setQuestion(value); setLoading(true); setError("");
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "暂时无法回答");
      setAnswer(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法回答");
    } finally { setLoading(false); }
  }

  return (
    <section className="instrument-panel mb-7" aria-labelledby="course-search-title">
      <div className="relative p-4 md:p-5">
        <div className="flex items-start gap-2.5 border-b border-[#bca064]/30 pb-3">
          <LibraryBig className="mt-1 size-4 shrink-0 text-[#d8bc7a]" />
          <div><p className="text-[10px] font-bold uppercase tracking-[.19em] text-[#c6aa6b]">Archive enquiry</p><h2 id="course-search-title" className="mt-0.5 text-lg font-semibold">资料检索与 AI 总结</h2><p className="mt-1 text-xs leading-5 text-white/58">查找 Canvas、Piazza 本地归档与日程，或直接要求按课程总结。</p></div>
        </div>

        <form onSubmit={(event) => void ask(event)} className="mt-4 flex items-center gap-2 border border-[#9f8a60] bg-[#fbf7eb] p-1.5 shadow-inner">
          <Search className="ml-2 size-4 shrink-0 text-[#716b5d]" />
          <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：Lab 1 前 notebook 要完成什么？" className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm text-[#26312d] outline-none placeholder:text-[#8e8879]" aria-label="搜索网站内容" />
          <Button type="submit" size="icon" className="rounded-none border border-[#c7ad70]" disabled={loading || question.trim().length < 2} aria-label="发送问题"><ArrowUp className={loading ? "animate-pulse" : ""} /></Button>
        </form>

        {!answer && !loading && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">{examples.map((example) => <button key={example} onClick={() => void ask(undefined, example)} className="border-b border-transparent py-1 text-left text-xs text-white/62 transition hover:border-[#c6aa6b] hover:text-white">{example}</button>)}</div>}
        {loading && <div className="mt-4 flex items-center gap-3 text-sm text-white/65"><span className="size-2 animate-pulse rounded-full bg-[#c6aa6b]" />正在检索并核对来源…</div>}
        {error && <p className="mt-4 border border-rose-300/25 bg-rose-950/20 p-3 text-sm text-rose-100">{error}</p>}

        {answer && !loading && (
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="botanical-answer border border-[#b6a987] bg-[#f7f2e5] p-4 text-[#26312d] md:p-5">
              <div className="mb-3 flex items-center gap-2 border-b border-[#c7bda5] pb-2 text-xs font-semibold text-[#46685e]"><BookOpen className="size-4" />整理后的回答{answer.needsClarification && <span className="border border-amber-500/40 bg-amber-50 px-2 py-0.5 text-amber-800">需确认课程</span>}</div>
              <p className="whitespace-pre-wrap text-sm leading-7">{answer.answer}</p>
              {answer.coverage && <p className="mt-3 text-xs opacity-65">{answer.coverage}</p>}
              {answer.followUps?.length > 0 && <div className="mt-4 border-t border-[#c7bda5] pt-3 text-sm"><p className="font-semibold">{answer.needsClarification ? "还缺少这项信息：" : "继续追问"}</p>{answer.followUps.map((item) => <button key={item} type="button" onClick={() => void ask(undefined, item)} className="mt-1 block text-left text-[#315e53] hover:underline">· {item}</button>)}</div>}
              {answer.aiAvailable&&answer.feedbackId&&<MiniAiFeedback sourceType="course-analysis" sourceId={answer.feedbackId} metadata={{question}}/>}
            </div>
            <div className="space-y-2">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-[.16em] text-[#c6aa6b]">Sources · 回答依据</p>
              {answer.citations.map((citation) => {
                const content = <><div className="flex items-center gap-2 text-xs font-semibold text-[#d2b978]"><BookOpen className="size-3.5" />[{citation.ref}] {citation.courseCode}</div><p className="mt-1.5 text-sm font-medium leading-5 text-white">{citation.title}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-white/48">{citation.excerpt || citation.sourceType}</p></>;
                return citation.sourceUrl ? <a key={citation.ref} href={citation.sourceUrl} target="_blank" rel="noreferrer" className="block border border-white/12 bg-black/10 p-3 transition hover:border-[#c6aa6b]/50 hover:bg-black/20">{content}</a> : <div key={citation.ref} className="border border-white/12 bg-black/10 p-3">{content}</div>;
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
