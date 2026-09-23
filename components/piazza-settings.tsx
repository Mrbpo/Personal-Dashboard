"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Link2, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PiazzaClass = { nid: string; name: string; num: string; term: string; courseId?: string; courseCode?: string };
type PiazzaStatus = { connected: boolean; status: string; classes: PiazzaClass[]; lastSyncedAt: string | null; postCount: number; error: string | null; autoLoginEnabled: boolean; lastAutoLoginAt: string | null; autoLoginError: string | null };

export function PiazzaSettings({ initial }: { initial: PiazzaStatus }) {
  const [status, setStatus] = useState(initial);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [autoLogin, setAutoLogin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("正在连接…");
    try {
      const wasConnected = status.connected;
      const response = await fetch("/api/piazza/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, autoLogin: wasConnected || autoLogin }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "连接失败");
      setStatus(result); setPassword("");
      if (wasConnected) { setMessage("自动重登已开启。下次会话失效时会尝试恢复。"); return; }
      setMessage("已连接，正在读取最近帖子…");
      const syncResponse = await fetch("/api/piazza/sync", { method: "POST" });
      const syncResult = await syncResponse.json();
      if (!syncResponse.ok) throw new Error(syncResult.error || "已连接，但首次同步失败");
      const statusResponse = await fetch("/api/piazza/status");
      setStatus(await statusResponse.json());
      setMessage(`连接并同步完成：读取 ${syncResult.imported} 条最近帖子`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "连接失败"); }
    finally { setBusy(false); }
  }

  async function sync() {
    if (busy) return;
    setBusy(true); setMessage("正在读取最近帖子，第一次可能需要一些时间…");
    try {
      const response = await fetch("/api/piazza/sync", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "同步失败");
      const statusResponse = await fetch("/api/piazza/status");
      setStatus(await statusResponse.json());
      setMessage(`同步完成：读取 ${result.imported} 条最近帖子`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "同步失败"); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/piazza/connect", { method: "DELETE" });
    if (response.ok) {
      setStatus({ connected: false, status: "disconnected", classes: [], lastSyncedAt: null, postCount: 0, error: null, autoLoginEnabled: false, lastAutoLoginAt: null, autoLoginError: null });
      setMessage("Piazza 会话已删除；已同步的帖子仍保留在本地数据库。 ");
    } else setMessage("断开失败，请稍后再试");
    setBusy(false);
  }

  async function disableAutoLogin() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/piazza/auto-login", { method: "DELETE" });
      if (!response.ok) throw new Error("关闭自动重登失败");
      setStatus(current => ({ ...current, autoLoginEnabled: false, lastAutoLoginAt: null, autoLoginError: null }));
      setMessage("已删除服务器保存的 Piazza 登录凭据；当前会话仍可继续使用。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "关闭失败"); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-6 rounded-3xl border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="flex items-center gap-2 font-semibold"><Link2 className="size-4 text-indigo-500" />Piazza 本地归档</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">本地开发服务运行时默认每 30 分钟同步：刷新最近帖子，逐批补存历史正文与回复，保留修改版本。不会发布或修改帖子；断开连接不删除归档。AI 总结时会把选中的归档内容发送至配置的 AI 服务。</p><p className="mt-1 text-xs text-muted-foreground">已归档 {status.postCount} 条帖子；每轮每门课程最多读取 90 条，历史较多时会分轮补齐。自动重登：{status.autoLoginEnabled ? "已开启" : "未开启"}{status.lastAutoLoginAt ? ` · 上次成功 ${new Date(status.lastAutoLoginAt).toLocaleString("zh-CN")}` : ""}</p></div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.status === "connected" ? "bg-emerald-100 text-emerald-700" : status.status === "error" || status.status === "needs_reconnect" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>{status.status === "connected" ? "已连接" : status.status === "error" ? "同步异常" : status.status === "needs_reconnect" ? "需要重新登录" : "未连接"}</span>
      </div>

      {!status.connected ? (
        <div><form onSubmit={connect} className="mt-5 grid max-w-xl gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="piazza-email">Piazza 邮箱</Label><Input id="piazza-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
          <div className="space-y-2"><Label htmlFor="piazza-password">Piazza 密码</Label><Input id="piazza-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          <div className="sm:col-span-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoLogin} onChange={event => setAutoLogin(event.target.checked)} />会话失效时自动重新登录</label><p className="my-3 text-xs leading-5 text-muted-foreground">开启后，服务器会用独立密钥加密保存 Piazza 邮箱和密码，仅用于恢复登录；关闭自动重登或断开连接时会删除。不开启时密码只用于本次登录。</p><Button disabled={busy} className="rounded-xl"><Link2 className="size-4" />{busy ? "连接中…" : "连接 Piazza"}</Button></div>
        </form>{status.autoLoginEnabled && <Button className="mt-3" variant="outline" onClick={disableAutoLogin} disabled={busy}>关闭自动重登并删除凭据</Button>}</div>
      ) : (
        <div className="mt-5">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {status.classes.map((item) => <div key={item.nid} className="rounded-2xl border bg-background p-3"><p className="truncate text-sm font-medium">{item.num || item.name}</p><p className="mt-1 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="size-3.5" />{item.courseId?.startsWith("piazza:") ? "Piazza 独立课程" : "匹配 Canvas"} · {item.courseCode || item.num}</span></p></div>)}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3"><Button onClick={sync} disabled={busy} className="rounded-xl"><RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />同步 Piazza</Button><Button variant="outline" asChild><Link href="/piazza">查看摘要与问答</Link></Button>{status.autoLoginEnabled && <Button variant="outline" onClick={disableAutoLogin} disabled={busy}>关闭自动重登</Button>}<Button variant="outline" onClick={disconnect} disabled={busy} className="rounded-xl"><Unplug className="size-4" />断开连接</Button><span className="text-xs text-muted-foreground">{status.lastSyncedAt ? `上次同步 ${new Date(status.lastSyncedAt).toLocaleString("zh-CN")}` : "尚未同步"}</span></div>
          {!status.autoLoginEnabled && <form onSubmit={connect} className="mt-5 grid max-w-xl gap-3 rounded-xl border p-4 sm:grid-cols-2"><p className="sm:col-span-2 text-sm font-semibold">开启自动重登</p><Input type="email" autoComplete="username" aria-label="Piazza 邮箱" placeholder="Piazza 邮箱" value={email} onChange={event => setEmail(event.target.value)} required /><Input type="password" autoComplete="current-password" aria-label="Piazza 密码" placeholder="Piazza 密码" value={password} onChange={event => setPassword(event.target.value)} required /><p className="sm:col-span-2 text-xs text-muted-foreground">验证成功后才会加密保存凭据；当前已同步的帖子不受影响。</p><Button disabled={busy} className="w-fit sm:col-span-2">验证并开启</Button></form>}
        </div>
      )}
      {message && <p aria-live="polite" className="mt-4 text-sm text-muted-foreground">{message}</p>}
      {status.error && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{status.error}</p>}
      {status.autoLoginError && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{status.autoLoginError}</p>}
    </section>
  );
}
