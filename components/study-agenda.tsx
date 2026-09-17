'use client';
import { useEffect, useState } from 'react';
import type { buildAgenda } from '@/lib/study-agenda';
import { Button } from '@/components/ui/button';
type Agenda = ReturnType<typeof buildAgenda>;
export function StudyAgenda() {
  const [data, setData] = useState<Agenda | null>(null);
  const [date, setDate] = useState('');
  const [start, setStart] = useState('19:00');
  const [end, setEnd] = useState('22:00');
  const [minutes, setMinutes] = useState(150);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch('/api/agenda'); if (!response.ok) throw new Error('暂时无法生成日程');
    const result = await response.json(); setData(result); setDate(d => d || result.days[0]); setStart(result.prefs.start); setEnd(result.prefs.end); setMinutes(result.prefs.minutes);
  }
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  async function update(body: object) {
    setBusy(true); setError('');
    try { const r = await fetch('/api/agenda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error((await r.json()).error); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { timeZone: data?.timezone || 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false });
  const blocks = data?.blocks.filter(b => b.date === date) || [];
  const projects = [...new Set(data?.blocks.map(b => b.taskId))];
  return <section id="study-agenda" className="parchment-panel mt-5 min-w-0 p-4 md:p-6">
    <p className="section-kicker">DAILY ITINERARY</p><h2 className="text-2xl font-semibold">逐日学习日程</h2>
    <p className="mt-2 text-sm text-muted-foreground">未来 14 天 · {data?.timezone || 'America/Toronto'} · 建议安排，不改动 Canvas 截止时间。每次重排把尚未完成的步骤放入剩余时段。</p>
    <details className="mt-4 rounded-lg border p-3"><summary className="cursor-pointer font-medium">学习时段与预算 {data?.prefs.confirmed ? '· 已设置' : '· 当前是建议默认值，请确认'}</summary><div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">每天开始<input className="rounded border bg-background p-2" type="time" value={start} onChange={e => setStart(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">每天结束<input className="rounded border bg-background p-2" type="time" value={end} onChange={e => setEnd(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">学习预算（不含休息）<input className="w-28 rounded border bg-background p-2" type="number" min={15} max={720} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
      <Button disabled={busy} onClick={() => update({ prefs: { start, end, minutes } })}>保存并重排</Button>
    </div><p className="mt-2 text-xs">导入日程占用的时间会避开；两段学习之间预留 10 分钟。全天日程按整天占用处理。当前每天使用同一学习时段。</p></details>
    <div className="my-4 flex flex-wrap items-center gap-3"><label>查看日期 <select className="ml-2 rounded border bg-background p-2" value={date} onChange={e => setDate(e.target.value)}>{data?.days.map(d => <option key={d}>{d}</option>)}</select></label><Button variant="outline" disabled={busy} onClick={() => { setBusy(true); load().catch(e => setError(e.message)).finally(() => setBusy(false)); }}>重新安排未完成步骤</Button><span className="text-sm">本日 {blocks.reduce((sum,b) => sum+b.minutes,0)} 分钟 · {blocks.length} 段 / 预算 {data?.prefs.minutes ?? minutes} 分钟</span></div>
    {error && <p role="alert" className="text-amber-800">{error}</p>}
    {!data && !error && <p>正在整理要求和空闲时段…</p>}
    {data && !blocks.length && <p className="rounded border border-dashed p-5">当天没有可排入的步骤。请查看下方限制提示，或选择其他日期。</p>}
    <ol className="space-y-3">{blocks.map((b, i) => <li key={b.id} className="rounded-xl border bg-background/80 p-4">
      <div className="grid gap-3 md:grid-cols-[8rem_minmax(0,1fr)_auto]"><div className="font-semibold">{time(b.start)}–{time(b.end)}<p className="mt-1 text-xs font-normal text-muted-foreground">约 {b.minutes} 分钟 · 估时</p></div><div className="min-w-0"><p className="text-xs text-muted-foreground">{b.course}</p><h3 className="font-semibold">{b.title}</h3><p className="mt-2 break-words"><strong>具体做：</strong>{b.action}</p><p className="mt-2 break-words text-emerald-900"><strong>做到这里：</strong>{b.target}</p><details className="mt-2 text-sm"><summary className="cursor-pointer">为什么安排 / 原文依据</summary><p className="mt-2">{b.reason}</p><p className="mt-1 break-words">{b.evidence || '暂无直接证据，请核对原文。'}</p>{b.sourceUrl && <a className="underline" href={b.sourceUrl} target="_blank" rel="noreferrer">打开课程来源</a>}</details></div><Button variant="outline" disabled={busy} onClick={() => update({ completedId: b.id })}>此段已完成</Button></div>
      {i < blocks.length-1 && <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">下一段之前已留出休息或其他日程时间。</p>}
    </li>)}</ol>
    <details className="mt-5 rounded-lg border p-4"><summary className="cursor-pointer font-semibold">跨天项目 · 查看每天做到哪里</summary><div className="mt-3 space-y-4">{projects.map(id => { const rows = data!.blocks.filter(b => b.taskId === id); return <details key={id} className="rounded border p-3"><summary className="cursor-pointer">{rows[0].title} · {new Set(rows.map(b => b.date)).size} 天 · {rows.length} 段</summary><ol className="mt-2 space-y-2">{rows.map(b => <li key={b.id} className="border-l-2 pl-3 text-sm"><strong>{b.date} {time(b.start)}–{time(b.end)}</strong><p>{b.action}</p><p className="text-muted-foreground">完成标准：{b.target}</p></li>)}</ol></details>; })}</div></details>
    {!!data?.warnings.length && <details className="mt-4 rounded border border-amber-700/30 p-3"><summary className="cursor-pointer font-semibold text-amber-900">需要调整或确认 · {data.warnings.length} 项</summary><ul className="mt-2 space-y-2 text-sm">{data.warnings.map((w,i) => <li key={i}><strong>{w.title}：</strong>{w.reason}</li>)}</ul></details>}
    <p className="mt-4 text-xs text-muted-foreground">“此段已完成”只记录本站学习进度，不代表作业已提交。误点可<Button variant="link" disabled={busy} onClick={() => update({ resetCompleted: true })}>恢复全部步骤</Button>。步骤依据现有任务要求整理；估时和建议日期不是老师规定。</p>
  </section>;
}
