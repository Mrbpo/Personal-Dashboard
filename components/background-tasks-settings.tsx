'use client';
import {useCallback,useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import type {TaskSummary} from '@/lib/background-tasks';

type SubtitleRow={id:string|null;title:string;courseId:string;state:string;stage:string|null;reason:string|null;durationMs:number;englishCoveredMs:number;completedChunks:number;totalChunks:number;translatedCues:number;totalCues:number;published:boolean;partial:boolean;complete:boolean;startedAt:string|null;updatedAt:string|null;retryAt:string|null};
type Status={tasks:TaskSummary[];budget:{used:number;limit:number;subtitleCalls:number;subtitleDailyLimit:number};parallel:null|{configured:number;admitted:number|null;active:number};hostUpdatedAt:string|null;hostStale:boolean;automaticSync:boolean;worker:{online:boolean;paused:boolean;heartbeat:number|null};subtitles:null|{total:number;states:Record<string,number>;complete:number;englishComplete:number;published:number;unreadable:number;items:SubtitleRow[]}};
const stateNames:Record<string,string>={idle:'尚未执行',running:'处理中',queued:'等待执行',pending:'等待执行',deferred:'等待恢复',interrupted:'执行中断，待接管',failed:'失败',complete:'已完成',completed:'已完成',needs_auth:'需要授权',unavailable:'状态不可用'};
const stages:Record<string,string>={audio:'提取音频',transcription:'英文转写',publish_english:'发布英文字幕',translation:'中文翻译'};
const minutes=(ms:number)=>`${Math.floor(ms/60000)}分${Math.floor(ms%60000/1000)}秒`;
export function BackgroundTasksSettings({timezone='America/Toronto'}:{timezone?:string}){
 const [data,setData]=useState<Status|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(''),[filter,setFilter]=useState('all');
 const time=(value:string|number|null)=>{if(!value)return '—';try{return new Date(value).toLocaleString('zh-CN',{timeZone:timezone,hour12:false});}catch{return '—';}};
 const load=useCallback(async(signal?:AbortSignal)=>{
  const response=await fetch('/api/settings/background-tasks',{cache:'no-store',signal});const body=await response.json();
  if(!response.ok)throw new Error(body.error||'后台状态读取失败');setData(body);setError('');
 },[]);
 useEffect(()=>{
  const controller=new AbortController();let loading=false;
  const refresh=async(force=false)=>{if(loading||!force&&document.hidden)return;loading=true;try{await load(controller.signal);}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'后台状态读取失败');}finally{loading=false;}};
  void refresh(true);const timer=setInterval(()=>void refresh(),10000);return()=>{controller.abort();clearInterval(timer);};
 },[load]);
 async function run(task:string){
  if(busy)return;setBusy(task);setMessage('');
  try{
   const response=await fetch('/api/settings/background-tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task})});const result=await response.json();
   if(!response.ok)throw new Error(result.error||'任务未能提交');setMessage(result.existing?'已有任务或待办，未重复提交。':'已提交执行请求。');await load();
  }catch(reason){setError(reason instanceof Error?reason.message:'任务未能提交');}finally{setBusy('');}
 }
 const subtitles=data?.subtitles;
 const visible=subtitles?.items.filter(row=>filter==='all'||filter==='failed'&&row.state==='failed'||filter==='running'&&row.state==='running'||filter==='complete'&&row.complete)||[];
 return <section className="mt-6 rounded-3xl border bg-card p-6 shadow-sm" aria-labelledby="background-tasks-heading">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="background-tasks-heading" className="font-semibold">后台任务与字幕进度</h2><Button variant="outline" size="sm" onClick={()=>void load().catch(reason=>setError(reason.message))}>刷新状态</Button></div>
  {error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{message&&<p role="status" className="mt-3 text-sm">{message}</p>}
  {!data?<p className="mt-4 text-sm">正在读取后台进度…</p>:<>
   <p className="mt-3 text-xs text-muted-foreground">网站后台：{data.worker.paused?'已暂停':data.worker.online?'运行中':'未连接'} · 自动同步：{data.automaticSync?'开启':'关闭'} · 录像进度更新：{time(data.hostUpdatedAt)}</p>
   {data.parallel&&<p className="mt-2 text-sm">字幕最多 {data.parallel.configured} 路并行 · 当前 {data.parallel.active} 路{data.parallel.admitted===1&&data.parallel.configured===2?' · 本轮按内存余量使用一路':''}</p>}
   <p className="mt-2 text-xs text-muted-foreground">本月运行预算占用（含预留）：${data.budget.used.toFixed(2)} / ${data.budget.limit.toFixed(2)} · 字幕翻译批次：{data.budget.subtitleCalls}/{data.budget.subtitleDailyLimit}（每日 UTC 重置）</p>
   {data.hostStale&&<p className="mt-2 text-sm text-amber-700">录像进度尚未更新；以下显示最近保存的状态。</p>}
   {subtitles&&<>
    <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
     {([['录像视角',subtitles.total],['双语完成',subtitles.complete],['转写覆盖完成',subtitles.englishComplete],['处理中',subtitles.states.running||0],['等待',subtitles.states.pending||0],['暂缓',subtitles.states.deferred||0],['失败',subtitles.states.failed||0]] as const).map(([label,value])=><div key={label} className="rounded-xl border p-3"><div className="text-xs text-muted-foreground">{label}</div><strong className="text-xl">{value}</strong></div>)}
    </div>
    {subtitles.unreadable>0&&<p role="alert" className="mt-2 text-sm">{subtitles.unreadable} 路进度无法完整读取，未计为完成。</p>}
    <details className="mt-4 rounded-xl border p-3"><summary className="cursor-pointer text-sm font-medium">每路录像详情</summary>
     <select aria-label="筛选字幕任务" value={filter} onChange={event=>setFilter(event.target.value)} className="my-3 rounded border bg-background p-2 text-sm"><option value="all">全部</option><option value="running">处理中</option><option value="failed">失败</option><option value="complete">双语完成</option></select>
     <div className="max-h-[32rem] space-y-3 overflow-auto">{visible.map((row,index)=><article key={row.id??index} className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><strong>{row.title}</strong><span>{row.complete?'双语已完成':row.state==='failed'?'失败':row.state==='running'?(stages[row.stage??'']??'处理中'):row.state==='completed'?'发布需核查':stateNames[row.state]??row.state}</span></div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3"><p>英文：{minutes(row.englishCoveredMs)} / {row.durationMs?minutes(row.durationMs):'时长未知'}（{row.completedChunks}/{row.totalChunks||'?'} 段）</p><p>中文：{row.translatedCues} / {row.totalCues||'?'} 条</p><p>发布：{row.published?(row.partial?'仅片段':row.complete?'完整双语':'仅英文或部分翻译'):'尚未发布'}</p></div>
      <progress aria-label={`${row.title}英文转写进度`} className="mt-2 h-2 w-full" max={row.durationMs||1} value={Math.min(row.englishCoveredMs,row.durationMs||0)}/>
      {row.reason&&<p className="mt-2 text-amber-700">{row.reason}</p>}
      <p className="mt-1 text-xs text-muted-foreground">本次开始：{time(row.startedAt)} · 进度更新：{time(row.updatedAt)}{row.retryAt?` · 最早续跑：${time(row.retryAt)}`:''}</p>
     </article>)}</div>
    </details>
   </>}
   <div className="mt-5 space-y-3">{data.tasks.map(task=><div key={task.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
    <div className="min-w-0 text-sm"><strong>{task.label}</strong><span className="ml-3">{task.configured?(task.id==='night'&&task.state==='complete'?'调度完成':stateNames[task.state]??task.state):'未配置'}</span><p className="mt-1 text-xs text-muted-foreground">{task.schedule} · 自动{task.automatic?'开启':'关闭'}{task.queued?` · 待办 ${task.queued}`:''}{task.failed?` · 历史失败 ${task.failed}`:''}</p>
     <p className="mt-1 text-xs text-muted-foreground">上次成功：{time(task.lastSuccessAt)}{task.nextRunAt?` · 下次执行：${time(task.nextRunAt)}`:''}</p>{task.reason&&<p className="mt-1 text-xs text-amber-700">{task.reason}</p>}
    </div><Button variant="outline" size="sm" disabled={!task.canRun||!!busy} onClick={()=>void run(task.id)}>{busy===task.id?'正在提交…':task.id==='subtitles'?'处理全部待办':'立即执行一次'}</Button>
   </div>)}</div>
  </>}
 </section>;
}
