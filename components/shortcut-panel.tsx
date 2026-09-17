"use client";
/* eslint-disable @next/next/no-img-element -- user-defined favicons are tiny external assets with dynamic hosts */

import { FormEvent, useEffect, useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Shortcut = { id: string; title: string; url: string; iconUrl: string | null };

export function ShortcutPanel() {
  const [items, setItems] = useState<Shortcut[]>([]);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await fetch("/api/shortcuts");
    if (response.ok) setItems((await response.json()).shortcuts || []);
  }
  useEffect(() => { void load(); }, []);

  async function add(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/shortcuts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, url }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "添加失败");
      setTitle(""); setUrl(""); setAdding(false); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "添加失败"); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    const response = await fetch(`/api/shortcuts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) setItems((current) => current.filter((item) => item.id !== id));
  }

  return (
    <section id="shortcuts" className="parchment-panel h-full p-4 md:p-5">
      <div className="flex items-center justify-between gap-3"><div><p className="section-kicker">SHORTCUTS</p><h2 className="text-xl font-semibold">快捷入口</h2></div><Button variant="outline" size="sm" className="rounded-xl" onClick={() => setAdding((value) => !value)}><Plus className="size-4" />添加</Button></div>
      {adding && <form onSubmit={add} className="mt-4 grid gap-3 rounded-2xl bg-muted/55 p-4 md:grid-cols-[minmax(10rem,.7fr)_minmax(16rem,1.3fr)_auto]"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="网站名称" maxLength={80} required /><Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" type="url" required /><Button disabled={busy} className="rounded-xl">{busy ? "添加中…" : "保存"}</Button>{message && <p className="text-sm text-destructive md:col-span-3">{message}</p>}</form>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => <div key={item.id} className="group flex min-w-0 items-center gap-3 rounded-2xl border bg-background p-3 transition hover:border-primary/30 hover:shadow-sm"><a href={item.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-3"><span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl border bg-white text-sm font-bold text-primary">{item.iconUrl && !broken.includes(item.id) ? <img src={item.iconUrl} alt="" className="size-6 object-contain" onError={() => setBroken((current) => [...current, item.id])} /> : item.title.slice(0, 1).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground"><ExternalLink className="size-3" />{new URL(item.url).hostname}</span></span></a><button onClick={() => void remove(item.id)} className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100" aria-label={`删除 ${item.title}`}><Trash2 className="size-3.5" /></button></div>)}
        {!items.length && !adding && <button onClick={() => setAdding(true)} className="rounded-2xl border border-dashed p-5 text-left text-sm text-muted-foreground hover:border-primary/35 hover:text-foreground">添加常用网站，图标会自动读取</button>}
      </div>
    </section>
  );
}
