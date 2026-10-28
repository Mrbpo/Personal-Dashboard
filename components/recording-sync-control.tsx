"use client";

import {useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {AlertTriangle, RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';

type RecordingControlStatus = {
  configured:boolean;
  state:'idle'|'running'|'needs_auth'|'failed'|'completed';
  reasonCode:string|null;
  updatedAt:string|null;
  lastSuccessAt:string|null;
  authorizationActive:boolean;
  requestId?:string;
  pending:boolean;
};
const controlUrl='/api/recordings/control';
const pollLimitMs=15*60*1000;
const statusLabels:Record<RecordingControlStatus['state'],string>={
  idle:'等待下次检查',running:'正在归档录像',needs_auth:'需要重新授权',failed:'本次同步未完成',completed:'同步已完成',
};

async function readStatus(signal:AbortSignal) {
  const response=await fetch(controlUrl,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  if(!response.ok)throw new Error(response.status===401?'请先登录后查看录像同步状态。':'暂时无法读取录像同步状态。');
  return await response.json() as RecordingControlStatus;
}
function lastSuccess(value:string|null) {
  if(!value || !Number.isFinite(Date.parse(value)))return '尚无完成记录';
  return new Date(value).toLocaleString('zh-CN');
}

/** A single read on the homepage; visiting it never starts a sync or login. */
export function RecordingSyncBanner() {
  const [status,setStatus]=useState<RecordingControlStatus|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void readStatus(controller.signal).then(value=>{if(!controller.signal.aborted)setStatus(value);}).catch(()=>{});
    return ()=>controller.abort();
  },[]);
  if(!status?.configured || !['needs_auth','failed'].includes(status.state))return null;
  const canvasAccessRequired=status.reasonCode==='CANVAS_ACCESS_REQUIRED';
  return <section role="status" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-600/30 bg-amber-500/10 p-4 text-sm">
    <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0"/>{canvasAccessRequired?'课程录像无法连接 Canvas，请先检查设置中的 Canvas 访问令牌。':status.state==='needs_auth'
      ?'课程录像需要重新授权，暂时无法获取新录像。'
      :'课程录像同步未完成，请查看状态并重试。'}</p>
    <Link href={canvasAccessRequired?'/settings':'/recordings#authorization'} className="font-medium text-primary underline underline-offset-4">{canvasAccessRequired?'检查 Canvas 连接':status.state==='needs_auth'?'前往授权':'查看录像同步'}</Link>
  </section>;
}

export function RecordingSyncControl() {
  const [status,setStatus]=useState<RecordingControlStatus|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [polling,setPolling]=useState(false);
  const [trackingEnded,setTrackingEnded]=useState(false);
  const pollStarted=useRef(0);
  const activeRequest=useRef<AbortController|null>(null);

  useEffect(()=>{
    const controller=new AbortController();
    void readStatus(controller.signal).then(value=>{if(!controller.signal.aborted)setStatus(value);})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'无法读取同步状态。');});
    return ()=>{controller.abort();activeRequest.current?.abort();};
  },[]);

  useEffect(()=>{
    if(!polling || !status)return;
    if(!status.pending && status.state!=='running') {setPolling(false);return;}
    const controller=new AbortController();
    const timer=setTimeout(()=>{
      if(Date.now()-pollStarted.current>=pollLimitMs){setPolling(false);setTrackingEnded(true);return;}
      void readStatus(controller.signal).then(value=>{if(!controller.signal.aborted)setStatus(value);})
        .catch(reason=>{if(!controller.signal.aborted){setPolling(false);setError(reason instanceof Error?reason.message:'无法读取同步状态。');}});
    },5000);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[polling,status]);

  async function refreshStatus() {
    if(busy)return;
    const controller=new AbortController();
    activeRequest.current?.abort();activeRequest.current=controller;
    setBusy(true);setError('');
    try {const value=await readStatus(controller.signal);if(!controller.signal.aborted)setStatus(value);}
    catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'无法读取同步状态。');}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }

  async function start(action:'sync'|'reauthorize') {
    if(busy || !status?.configured)return;
    const controller=new AbortController();
    activeRequest.current?.abort();activeRequest.current=controller;
    setBusy(true);setError('');setTrackingEnded(false);
    try {
      const response=await fetch(controlUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
      const result=await response.json().catch(()=>null) as {error?:unknown}|null;
      if(!response.ok)throw new Error(typeof result?.error==='string'?result.error:'请求未能提交，请稍后重试。');
      const value=await readStatus(controller.signal);
      if(controller.signal.aborted)return;
      setStatus(value);pollStarted.current=Date.now();setPolling(value.pending || value.state==='running');
    } catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'请求未能提交。');}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }

  const working=Boolean(status?.pending || status?.state==='running');
  const canvasAccessRequired=status?.reasonCode==='CANVAS_ACCESS_REQUIRED';
  return <section id="authorization" aria-label="录像同步与授权" className="mb-5 scroll-mt-5 rounded-lg border bg-card p-4 md:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-medium">录像同步与授权</h2>
        <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">{!status?'正在读取状态…':!status.configured?'未启用后台同步':canvasAccessRequired?'Canvas 连接不可用，请先在设置更新访问令牌；Duo 授权不能修复此连接。':status.authorizationActive?'授权窗口已就绪，请在下方完成验证':status.pending?'请求已提交，等待处理':statusLabels[status.state]}</p>
        {status?.configured && <p className="mt-1 text-xs text-muted-foreground">上次同步成功：{lastSuccess(status.lastSuccessAt)}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新录像同步状态" disabled={busy || polling} onClick={()=>void refreshStatus()}><RefreshCw className={busy?'animate-spin':''}/></Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || !status?.configured || working || status?.authorizationActive} onClick={()=>void start('sync')}>检查新录像</Button>
        {canvasAccessRequired && <Button asChild variant="outline" size="sm"><Link href="/settings">检查 Canvas 连接</Link></Button>}
        <Button type="button" variant="outline" size="sm" disabled={busy || !status?.configured || working || status?.authorizationActive || canvasAccessRequired} onClick={()=>void start('reauthorize')}>重新授权</Button>
      </div>
    </div>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">每日 04:00 自动检查新录像（多伦多时间）。</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {trackingEnded && <p className="mt-3 text-sm text-muted-foreground">本次页面状态跟踪已达 15 分钟。后台任务继续运行，可刷新状态查看进度。</p>}
    {status?.authorizationActive && !canvasAccessRequired && <div className="mt-4">
      <p className="mb-3 text-sm leading-6">请在下方临时浏览器中完成学校登录、人机验证及 Duo 授权。完成后等待录像归档继续。</p>
      <iframe title="课程录像学校授权窗口" src="/recordings/authorize/vnc.html?autoconnect=1&resize=scale&path=recordings/authorize/websockify" className="h-[70vh] min-h-[460px] w-full rounded-md border bg-black" referrerPolicy="same-origin"/>
    </div>}
  </section>;
}
