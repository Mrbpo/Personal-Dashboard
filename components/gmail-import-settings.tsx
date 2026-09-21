'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';

export function GmailImportSettings(){
 const [state,setState]=useState<any>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function load(){const response=await fetch('/api/mail?state=1',{cache:'no-store'}),value=await response.json();if(!response.ok)throw new Error(value.error||'无法读取 Gmail 状态');setState(value);}
 useEffect(()=>{void load().catch(error=>setMessage(error.message));},[]);
 useEffect(()=>{if(state?.import?.status!=='running')return;const timer=setInterval(()=>void load().catch(()=>{}),5000);return()=>clearInterval(timer);},[state?.import?.status]);
 async function importAll(){
  if(!window.confirm('导入全部 Gmail 历史邮件可能需要较长时间并占用服务器存储。导入本身不会调用 AI、不会发送邮件、不会删除或标记已读。确认开始吗？'))return;
  setBusy(true);setMessage('');try{const response=await fetch('/api/mail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'import-all'})}),value=await response.json();if(!response.ok)throw new Error(value.error||'无法开始导入');setMessage('全部历史邮件导入已排队；可以关闭此页面，后台会继续。');await load();}catch(error:any){setMessage(error.message);}finally{setBusy(false);}
 }
 const progress=state?.import,percent=progress?.estimated?Math.min(100,Math.round(progress.processed/progress.estimated*100)):null;
 return <details className="parchment-panel mt-6 p-5"><summary className="cursor-pointer font-semibold">Gmail 高级选项</summary><div className="mt-4 space-y-3 text-sm"><p className="text-muted-foreground">默认只同步最近 90 天。这里可以一次性导入全部历史邮件；邮件保存在你的服务器。每天凌晨会分批整理尚未分析或版本过旧的非垃圾邮件，直到完成，并受现有 AI 月度预算保护。</p><p>{state?.connected?`已连接：${state.email} · 本地 ${state.messageCount||0} 封`:'尚未连接 Gmail'}</p>{progress?.status==='running'&&<div><p>正在导入：已处理 {progress.processed}{progress.estimated?` / 约 ${progress.estimated}`:''} 封{percent!=null?`（${percent}%）`:''}</p><div className="mt-2 h-2 overflow-hidden rounded bg-black/10"><div className="h-full bg-primary transition-all" style={{width:`${percent??12}%`}} /></div></div>}{progress?.status==='complete'&&<p>上次全部导入已完成：处理 {progress.processed} 封。</p>}{progress?.status==='error'&&<p className="text-amber-800">上次导入中断；点击按钮会从头安全重试，已保存邮件不会重复。</p>}<Button variant="outline" disabled={busy||!state?.connected||progress?.status==='running'} onClick={importAll}>{busy?'正在开始…':progress?.status==='running'?'导入进行中':'导入全部历史邮件'}</Button>{message&&<p role="status">{message}</p>}</div></details>;
}
