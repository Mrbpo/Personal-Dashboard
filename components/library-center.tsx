'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from './ui/button';

type Course={id:string;code:string};
type DocumentRow={id:string;course_id:string;name:string;origin:string;status:string;size:number;created_at:string;error?:string};
type SearchMatch={id:string;document_id:string;name:string;course_id:string;locator:string;body:string;score:number};

export function LibraryCenter({courses}:{courses:Course[]}){
  const [docs,setDocs]=useState<DocumentRow[]>([]),[status,setStatus]=useState<any>({jobs:[]});
  const [course,setCourse]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [query,setQuery]=useState(''),[matches,setMatches]=useState<SearchMatch[]>([]),[searching,setSearching]=useState(false);
  const [checkedAt,setCheckedAt]=useState(0);
  const file=useRef<HTMLInputElement>(null);

  async function load(){
    const [a,b]=await Promise.all([fetch('/api/library'),fetch('/api/jobs')]);
    if(!a.ok||!b.ok)throw new Error('读取资料状态失败');
    setDocs(await a.json());setStatus(await b.json());setCheckedAt(Date.now());
  }
  useEffect(()=>{void load().catch(e=>setMessage(e.message));const timer=setInterval(()=>void load().catch(()=>{}),15000);return()=>clearInterval(timer);},[]);

  async function upload(){
    const selected=file.current?.files?.[0];if(!selected)return;
    setBusy(true);
    try{
      const form=new FormData();form.set('file',selected);form.set('courseId',course);
      const response=await fetch('/api/library',{method:'POST',body:form}),json=await response.json();
      if(!response.ok)throw new Error(json.error);
      setMessage('已保存原件并排队逐页转文字；解析完成后可直接搜索。');await load();
    }catch(error:any){setMessage(error.message);}finally{setBusy(false);}
  }
  async function job(kind:string){
    const response=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})});
    setMessage(response.ok?'任务已排队':'排队失败');await load();
  }
  async function search(){
    if(query.trim().length<2){setMatches([]);setMessage('请输入至少两个字符。');return;}
    setSearching(true);
    try{
      const params=new URLSearchParams({q:query.trim()});if(course)params.set('course',course);
      const response=await fetch('/api/library/search?'+params),json=await response.json();
      if(!response.ok)throw new Error(json.error);setMatches(json.matches||[]);
      setMessage(json.matches?.length?`找到 ${json.matches.length} 条相关原文。`:'没有找到相关原文，可以换一个关键词或取消课程筛选。');
    }catch(error:any){setMessage(error.message);}finally{setSearching(false);}
  }

  return <div className="space-y-5">
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="mb-3 text-lg font-semibold">搜索已归档资料</h2>
      <div className="flex flex-col gap-3 md:flex-row">
        <input aria-label="搜索资料正文" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void search();}} placeholder="输入概念、作业要求、文件内容……" className="min-w-0 flex-1 rounded border bg-background p-2"/>
        <select aria-label="搜索课程范围" className="rounded border bg-background p-2" value={course} onChange={e=>setCourse(e.target.value)}><option value="">全部课程</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select>
        <Button disabled={searching} onClick={search}>{searching?'检索中…':'搜索原文'}</Button>
      </div>
      {matches.length>0&&<div className="mt-4 space-y-3">{matches.map(match=><article key={match.id} className="rounded-xl border bg-background p-4"><div className="flex flex-wrap justify-between gap-2"><a href={'/api/library/'+match.document_id} className="break-words font-semibold underline">{match.name}</a><span className="text-xs text-muted-foreground">{match.locator}</span></div><p className="mt-2 line-clamp-5 whitespace-pre-wrap text-sm leading-6">{match.body}</p></article>)}</div>}
    </section>

    <section className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-3"><select aria-label="资料所属课程" className="max-w-full rounded border bg-background p-2" value={course} onChange={e=>setCourse(e.target.value)}><option value="">通用资料</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select><input ref={file} aria-label="上传资料" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.txt,.md" className="max-w-full text-sm"/><Button disabled={busy} onClick={upload}>保存到资料库</Button></div>
      <p className="mt-3 text-xs text-muted-foreground">单份最多 50 MB。PDF 优先读取原生文字层，扫描页自动 OCR；原件、页码和版本均私有保存。既有 Canvas 下载目录可用本机导入脚本上传，不扫描其他目录。</p>
    </section>
    {message&&<p role="status" className="rounded border p-3 text-sm">{message}</p>}
    <section className="rounded-2xl border bg-card p-5"><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>job('canvas')}>立即同步 Canvas 全部资料</Button><Button variant="outline" onClick={()=>job('piazza')}>同步 Piazza</Button><Button variant="outline" onClick={()=>job('night')}>补齐 PDF 与语义索引</Button><Button variant="outline" onClick={()=>load().catch(e=>setMessage(e.message))}>刷新</Button></div><p className="mt-3 text-sm">后台：{status.worker&&checkedAt-status.worker.heartbeat<90000?'运行中':'未运行或心跳超时'} · AI 月度已用／预留 ${Number(status.budget?.used||0).toFixed(3)} / ${status.budget?.limit??30}</p><p className="mt-2 text-xs text-muted-foreground">Canvas 每 15 分钟自动检查；Piazza 每 30 分钟检查；每天 03:00 补齐失败页与向量索引。无变化不会重复处理或计费。</p></section>
    <div className="grid gap-3 md:grid-cols-2">{docs.filter(d=>!course||d.course_id===course).map(d=><article key={d.id} className="min-w-0 rounded-xl border bg-card p-4"><a href={'/api/library/'+d.id} className="break-words font-semibold underline">{d.name}</a><p className="mt-2 text-xs text-muted-foreground">{d.origin} · {d.status} · {Math.round(d.size/1024)} KB · {d.created_at}</p>{d.error&&<p className="mt-2 text-sm text-amber-800">{d.error}</p>}<button className="mt-3 text-xs underline" onClick={async()=>{if(!confirm('从资料库移除此版本？它将立即退出检索；备份与共享原件按保留策略清理。'))return;await fetch('/api/library/'+d.id,{method:'DELETE'});await load();}}>移除此版本</button></article>)}</div>
    <details className="rounded-xl border bg-card p-4"><summary>后台任务记录</summary>{status.jobs.map((j:any)=><div key={j.id} className="border-b py-2 text-xs">{j.kind} · {j.status} · 尝试 {j.attempts}{j.error&&<p>{j.error}</p>}{j.status==='failed'&&<button className="underline" onClick={async()=>{await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retry:j.id})});await load();}}>重试</button>}</div>)}</details>
  </div>;
}
