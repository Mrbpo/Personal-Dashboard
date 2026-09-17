"use client";

import { useEffect, useState } from "react";
import { Cpu, RefreshCw } from "lucide-react";

type Usage = { provider: string; configured: boolean; detailAvailable: boolean; primary: string; secondary: string; tone: "green" | "blue" | "amber" | "muted" };

export function AiUsagePanel() {
  const [providers, setProviders] = useState<Usage[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    const response = await fetch("/api/ai-usage");
    if (response.ok) setProviders((await response.json()).providers || []);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const colors = { green: "bg-emerald-500", blue: "bg-sky-500", amber: "bg-amber-500", muted: "bg-stone-400" };
  return (
    <section id="ai-usage" className="instrument-panel instrument-blue h-full p-4 md:p-5">
      <div className="flex items-center justify-between gap-3 border-b border-[#c2ab72]/30 pb-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#d0b975]">MODEL LEDGER</p><h2 className="mt-0.5 flex items-center gap-2 text-lg font-semibold"><Cpu className="size-4 text-[#dfc785]" />AI 服务账册</h2></div><button onClick={() => void load()} disabled={loading} className="border border-white/15 bg-black/10 p-2 text-white/60 transition hover:border-[#c2ab72]/50 hover:text-white" aria-label="刷新 AI 用量"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></button></div>
      <div className="mt-3 grid divide-y divide-white/10 border border-white/12 bg-black/15 md:grid-cols-3 md:divide-x md:divide-y-0">{(providers.length ? providers : ["OpenAI", "DeepSeek", "xAI"].map((provider) => ({ provider, configured: false, detailAvailable: false, primary: "读取中…", secondary: "正在检查服务器连接", tone: "muted" as const }))).map((item) => <div key={item.provider} className="p-3"><div className="flex items-center justify-between"><p className="text-sm font-semibold">{item.provider}</p><span className={`size-2 ${colors[item.tone]}`} /></div><p className="mt-2 break-words text-base font-semibold">{item.primary}</p><p className="mt-1 text-xs leading-5 text-white/48">{item.secondary}</p></div>)}</div>
    </section>
  );
}
