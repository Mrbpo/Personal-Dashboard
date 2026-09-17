'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
export function ChatGPTSettings() {
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => fetch('/api/chatgpt').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setStatus).catch(() => setError('无法读取 ChatGPT 连接状态'));
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 15000); return () => clearInterval(timer); }, []);
  async function action(action: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/chatgpt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (data.authUrl) window.location.assign(data.authUrl);
      else await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '连接失败'); } finally { setBusy(false); }
  }
  return <section className="parchment-panel mt-6 p-5" id="chatgpt">
    <h2 className="text-xl font-semibold">ChatGPT 登录与自动切换</h2>
    <p className="mt-2 text-sm text-muted-foreground">使用本机 Codex 的 ChatGPT 登录。与桌面 Codex 共享账号及额度；关闭此功能不会退出桌面账号。</p>
    <p className="mt-3">{status?.connected ? '已登录 ChatGPT' : '尚未连接'} · 剩余额度：{status?.remaining == null ? '未知' : `${status.remaining}%`} · 当前通道：{status?.provider === 'chatgpt' ? 'ChatGPT / Codex' : 'OpenAI API'}</p>
    <p className="mt-2 text-sm">所有已返回额度窗口取最低值。高于 50% 优先 ChatGPT，≤50%、额度未知或连接失败时使用付费 API；额度恢复后自动切回。文件附件始终使用 API。检查发生在每个新请求前，单次请求可能跨过阈值。</p>
    <p className="mt-2 text-sm">健康摘要、课程资料会发送给选中的服务。Codex 模式不适用 Responses API 的 store:false；本地分析会话设为临时会话。</p>
    {status && !status.apiConfigured && <p className="mt-2 text-amber-800">尚未配置 API Key，达到阈值后无法继续分析。</p>}
    {status && !status.available && <p className="mt-2 text-amber-800">本机 Codex 不可用，请在下方填写 Codex 程序路径。</p>}
    <div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy} onClick={() => action('login')}>登录 / 连接 ChatGPT</Button><Button variant="outline" disabled={busy || !status?.connected} onClick={() => action(status?.enabled ? 'disable' : 'enable')}>{status?.enabled ? '关闭自动切换' : '开启 50% 自动切换'}</Button><Button variant="outline" disabled={busy} onClick={refresh}>刷新状态</Button></div>
    {status?.lastRoute && <p className="mt-3 text-sm">最近请求：{status.lastRoute.provider} · {status.lastRoute.reason}</p>}
    {error && <p role="alert" className="mt-3 text-amber-800">{error}</p>}
  </section>;
}
