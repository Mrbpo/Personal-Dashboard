'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { HealthDay } from '@/lib/health-data';
import {MiniAiFeedback} from '@/components/mini-ai-feedback';
type Status = { configured: boolean; connected: boolean; aiConfigured: boolean; lastSyncedAt: string | null; days: HealthDay[]; errors: string[]; error: string | null; analysis: { text: string; generatedAt: string; model: string } | null };
export function HealthDashboard() {
  const [data, setData] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    const connection = new URLSearchParams(window.location.search).get('connection');
    if (connection === 'failed') setMessage('授权未完成或已过期，请重新连接，并检查 Google 应用的回调地址与测试用户设置。');
    if (connection === 'success') setMessage('授权成功，正在同步最近七天记录。');
    async function refresh() {
      try {
        const r = await fetch('/api/health'); if (!r.ok) throw new Error();
        let state = await r.json();
        if (state.connected && (!state.lastSyncedAt || Date.now() - Date.parse(state.lastSyncedAt) > 900000)) {
          const synced = await fetch('/api/health/sync', { method: 'POST' }); if (synced.ok) state = await synced.json();
        }
        if (active) setData(state);
      } catch { if (active) setMessage('暂时无法读取健康数据'); }
    }
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 900000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function action(name: string) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/health/' + name, { method: 'POST' }); const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败');
      if (name === 'connect') { window.location.assign(result.url); return; }
      if (name === 'analyze') setData(previous => previous ? { ...previous, analysis: result } : previous);
      else { const r = await fetch('/api/health'); if (!r.ok) throw new Error('读取失败'); setData(await r.json()); }
      if (name === 'disconnect') setMessage('本站的授权令牌、健康缓存与分析已清除。Google 账号中的授权可另行撤销。');
    } catch (e) { setMessage(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  const latest = data?.days.at(-1);
  const format = (value: number | null | undefined, unit: string) => value == null ? '暂无数据' : value.toLocaleString('zh-CN') + unit;
  return <div className="space-y-6">
    <section className="instrument-panel instrument-purple p-5">
      <h2 className="text-xl font-semibold">Fitbit · Google Health</h2>
      <p className="mt-2 text-sm">{!data ? '正在读取连接状态…' : data.connected ? '已连接 · 健康页打开期间每 15 分钟检查更新' : '连接后读取最近七天的设备记录'}</p>
      <div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy || !data?.configured} onClick={() => action('connect')}>{data?.connected ? '重新授权' : '连接 Fitbit 账号'}</Button><Link className="rounded border border-white/30 px-3 py-2 text-sm" href="/settings#services">配置接入信息</Link>{data?.connected && <><Button disabled={busy} onClick={() => action('sync')}>立即同步</Button><Button variant="outline" disabled={busy} onClick={() => { if (window.confirm('断开连接并清除本站保存的健康记录和分析？')) void action('disconnect'); }}>断开并清除本站数据</Button></>}</div>
      {data && !data.configured && <p className="mt-3 text-sm">还需要 Google OAuth Client ID 和 Client Secret，请在服务配置中填写。这里使用关联 Fitbit 的 Google 账号授权。</p>}
    </section>
    {message && <p role="status" className="rounded-lg border p-3">{message}</p>}
    {data?.error && <p role="alert" className="text-amber-800">{data.error}</p>}
    {!!data?.errors.length && <div className="rounded-lg border p-3 text-sm text-amber-800"><p>以下类别可能缺失或保留上次数据：</p>{data.errors.map(e => <p key={e}>{e}</p>)}</div>}
    <section className="parchment-panel p-5"><h2 className="text-lg font-semibold">{latest?.date || '今日'} · 数据总览</h2><p className="mt-1 text-xs text-muted-foreground">来源：Fitbit / Google 可穿戴设备。当天记录可能尚未完整；睡眠按结束日归属。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['步数', format(latest?.steps, ' 步')], ['睡眠', format(latest?.sleepMinutes, ' 分钟')], ['静息心率', format(latest?.restingHeartRate, ' 次/分')], ['运动时长', format(latest?.exerciseMinutes, ' 分钟')]].map(([label, value]) => <div key={label} className="rounded-lg border p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold">{value}</p></div>)}</div>
      <p className="mt-3 text-xs text-muted-foreground">最近成功同步：{data?.lastSyncedAt ? new Date(data.lastSyncedAt).toLocaleString('zh-CN') : '尚未同步'}</p>
    </section>
    <section className="parchment-panel p-5"><h2 className="text-lg font-semibold">近七天记录</h2>{!data?.days.length ? <p className="mt-3 text-muted-foreground">授权并同步后显示真实记录。</p> : <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{data.days.map(day => <div key={day.date} className="rounded-lg border p-3 text-sm"><p className="font-semibold">{day.date}</p><p className="mt-2">步数：{format(day.steps, ' 步')}</p><p>睡眠：{format(day.sleepMinutes, ' 分钟')}</p><p>静息心率：{format(day.restingHeartRate, ' 次/分')}</p><p>运动：{format(day.exerciseMinutes, ' 分钟')}</p></div>)}</div>}</section>
    <section className="parchment-panel botanical-answer p-5"><h2 className="text-lg font-semibold">AI 健康观察</h2><p className="mt-2 text-sm text-muted-foreground">点击分析会将近七天日汇总发送给你配置的 OpenAI 服务，不发送授权令牌或账号信息。解读用于生活记录，不作医学诊断。</p><Button className="mt-4" disabled={busy || !data?.aiConfigured || !data?.days.length} onClick={() => action('analyze')}>{busy ? '处理中…' : '分析近七天数据'}</Button>{!data?.aiConfigured && <p className="mt-2 text-sm">请先在服务配置中添加 OpenAI API Key。</p>}{data?.analysis && <><p className="mt-4 whitespace-pre-wrap text-sm leading-7">{data.analysis.text}</p><p className="mt-3 text-xs text-muted-foreground">{data.analysis.model} · {new Date(data.analysis.generatedAt).toLocaleString('zh-CN')} · 分析基于生成时的数据，更新后请重新分析。</p><MiniAiFeedback sourceType="health" sourceId={data.analysis.generatedAt} metadata={{model:data.analysis.model}}/></>}</section>
  </div>;
}
