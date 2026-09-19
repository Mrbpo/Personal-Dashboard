'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {ChevronRight,FileText,Folder,FolderOpen,House} from 'lucide-react';
import {Button} from './ui/button';

type Course={id:string;code:string};
type DocumentRow={id:string;course_id:string;name:string;origin:string;mime:string;status:string;size:number;created_at:string;error?:string};
type SearchMatch={id:string;document_id:string;name:string;course_id:string;locator:string;body:string;score:number};
type SourceFailure={origin:string;origin_key:string;course_id:string;name:string;error:string;updated_at:string};

const originNames:Record<string,string>={upload:'手动上传',canvas:'Canvas',piazza:'Piazza',mail:'邮件归档',gmail:'邮件归档'};
const originLabel=(origin:string)=>originNames[origin]||origin||'其他来源';
const documentKind=(document:DocumentRow)=>document.mime.startsWith('text/')?'text':'file';
const kindLabel=(kind:string)=>kind==='text'?'文本资料':'文件资料';
const sizeLabel=(bytes:number)=>bytes===0?'0 KB':bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1024))} KB`;

export function LibraryCenter({courses}:{courses:Course[]}){
  const [docs,setDocs]=useState<DocumentRow[]>([]),[status,setStatus]=useState<any>({jobs:[]});
  const [course,setCourse]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [query,setQuery]=useState(''),[matches,setMatches]=useState<SearchMatch[]>([]),[searching,setSearching]=useState(false);
  const [failures,setFailures]=useState<SourceFailure[]>([]),[checkedAt,setCheckedAt]=useState(0);
  const [browseCourse,setBrowseCourse]=useState<string|null>(null),[browseKind,setBrowseKind]=useState<string|null>(null);
  const file=useRef<HTMLInputElement>(null);

  const courseLabel=(id:string)=>courses.find(item=>item.id===id)?.code||'通用资料';
  const courseFolders=useMemo(()=>[{id:'',code:'通用资料'},...courses].map(item=>{
    const contents=docs.filter(doc=>doc.course_id===item.id);
    return {...item,count:contents.length,size:contents.reduce((sum,doc)=>sum+doc.size,0)};
  }),[courses,docs]);
  const currentCourseDocs=useMemo(()=>browseCourse===null?[]:docs.filter(doc=>doc.course_id===browseCourse),[browseCourse,docs]);
  const kindFolders=useMemo(()=>(['text','file'] as const).map(kind=>{
    const contents=currentCourseDocs.filter(doc=>documentKind(doc)===kind);
    return {kind,label:kindLabel(kind),count:contents.length,size:contents.reduce((sum,doc)=>sum+doc.size,0)};
  }),[currentCourseDocs]);
  const visibleFiles=useMemo(()=>browseKind===null?currentCourseDocs:currentCourseDocs.filter(doc=>documentKind(doc)===browseKind),[browseKind,currentCourseDocs]);

  async function load(){
    const [a,b,c]=await Promise.all([fetch('/api/library'),fetch('/api/jobs'),fetch('/api/library/failures')]);
    if(!a.ok||!b.ok||!c.ok)throw new Error('读取资料状态失败');
    setDocs(await a.json());setStatus(await b.json());setFailures((await c.json()).failures||[]);setCheckedAt(Date.now());
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
      setBrowseCourse(course);setBrowseKind(documentKind({...json,course_id:course,name:selected.name,origin:'upload',mime:selected.type||'application/octet-stream',status:'pending',size:selected.size,created_at:new Date().toISOString()}));
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
  function enterCourse(id:string){setBrowseCourse(id);setBrowseKind(null);setCourse(id);}
  function libraryHome(){setBrowseCourse(null);setBrowseKind(null);}

  return <div className="space-y-5">
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="mb-3 text-lg font-semibold">搜索已归档资料</h2>
      <div className="flex flex-col gap-3 md:flex-row">
        <input aria-label="搜索资料正文" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void search();}} placeholder="输入概念、作业要求、文件内容……" className="min-w-0 flex-1 rounded border bg-background p-2"/>
        <select aria-label="搜索课程范围" className="rounded border bg-background p-2" value={course} onChange={e=>setCourse(e.target.value)}><option value="">全部课程</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select>
        <Button disabled={searching} onClick={search}>{searching?'检索中…':'搜索原文'}</Button>
      </div>
      {matches.length>0&&<div className="mt-4 space-y-3">{matches.map(match=><article key={match.id} className="rounded-xl border bg-background p-4"><div className="flex flex-wrap justify-between gap-2"><a href={'/library/'+match.document_id} className="break-words font-semibold underline">{match.name}</a><span className="text-xs text-muted-foreground">{match.locator}</span></div><p className="mt-2 line-clamp-5 whitespace-pre-wrap text-sm leading-6">{match.body}</p></article>)}</div>}
    </section>

    <section className="overflow-hidden rounded-2xl border bg-card">
      <div className="border-b px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">LIBRARY DIRECTORY</p><h2 className="mt-1 text-xl font-semibold">资料目录</h2></div>
          <span className="text-sm text-muted-foreground">{docs.length} 份资料 · {sizeLabel(docs.reduce((sum,doc)=>sum+doc.size,0))}</span>
        </div>
        <nav aria-label="资料目录路径" className="mt-4 flex flex-wrap items-center gap-1 text-sm">
          <button onClick={libraryHome} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted"><House className="size-4"/>资料库</button>
          {browseCourse!==null&&<><ChevronRight className="size-4 text-muted-foreground"/><button onClick={()=>setBrowseKind(null)} className="rounded-lg px-2 py-1 hover:bg-muted">{courseLabel(browseCourse)}</button></>}
          {browseKind!==null&&<><ChevronRight className="size-4 text-muted-foreground"/><span className="rounded-lg bg-muted px-2 py-1">{kindLabel(browseKind)}</span></>}
        </nav>
      </div>

      {browseCourse===null?<div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
        {courseFolders.map(folder=><button key={folder.id||'general'} onClick={()=>enterCourse(folder.id)} className="group flex min-h-28 items-center gap-4 rounded-2xl border bg-background p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Folder className="size-6 fill-current/15"/></span>
          <span className="min-w-0"><strong className="block truncate text-base">{folder.code}</strong><span className="mt-1 block text-sm text-muted-foreground">{folder.count} 个文件 · {sizeLabel(folder.size)}</span></span>
          <ChevronRight className="ml-auto size-5 text-muted-foreground transition group-hover:translate-x-0.5"/>
        </button>)}
      </div>:browseKind===null?<div className="p-5">
        <div className="grid gap-3 sm:grid-cols-2">{kindFolders.map(folder=><button key={folder.kind} onClick={()=>setBrowseKind(folder.kind)} className="group flex min-h-28 items-center gap-4 rounded-2xl border bg-background p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FolderOpen className="size-6"/></span>
          <span className="min-w-0"><strong className="block truncate text-base">{folder.label}</strong><span className="mt-1 block text-sm text-muted-foreground">{folder.count} 个文件 · {sizeLabel(folder.size)}</span></span>
          <ChevronRight className="ml-auto size-5 text-muted-foreground transition group-hover:translate-x-0.5"/>
        </button>)}</div>
      </div>:<div className="grid gap-3 p-5 md:grid-cols-2">
        {visibleFiles.map(doc=><article key={doc.id} className="flex min-w-0 gap-3 rounded-xl border bg-background p-4">
          <FileText className="mt-0.5 size-5 shrink-0 text-primary"/>
          <div className="min-w-0 flex-1"><a href={'/library/'+doc.id} className="break-words font-semibold underline decoration-border underline-offset-4 hover:decoration-current">{doc.name}</a><p className="mt-2 text-xs text-muted-foreground">{originLabel(doc.origin)} · {doc.status} · {sizeLabel(doc.size)} · {new Date(doc.created_at).toLocaleString('zh-CN')}</p>{doc.error&&<p className="mt-2 text-sm text-amber-800">{doc.error}</p>}<button className="mt-3 text-xs underline" onClick={async()=>{if(!confirm('从资料库移除此版本？它将立即退出检索；备份与共享原件按保留策略清理。'))return;await fetch('/api/library/'+doc.id,{method:'DELETE'});await load();}}>移除此版本</button></div>
        </article>)}
        {!visibleFiles.length&&<p className="py-10 text-center text-muted-foreground md:col-span-2">这个文件夹目前为空。</p>}
      </div>}
    </section>

    <section className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-3"><select aria-label="资料所属课程" className="max-w-full rounded border bg-background p-2" value={course} onChange={e=>setCourse(e.target.value)}><option value="">通用资料</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select><input ref={file} aria-label="上传资料" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.txt,.md" className="max-w-full text-sm"/><Button disabled={busy} onClick={upload}>保存到资料库</Button></div>
      <p className="mt-3 text-xs text-muted-foreground">上传后会自动放入所选课程的“文本资料”或“文件资料”目录。单份最多 50 MB；原件、页码和版本均私有保存。</p>
    </section>
    {message&&<p role="status" className="rounded border p-3 text-sm">{message}</p>}
    {failures.length>0&&<details className="rounded-xl border border-amber-700/40 bg-amber-50/40 p-4"><summary>{failures.length} 个来源暂时无法完整归档</summary><p className="my-2 text-xs text-muted-foreground">其他资料仍会继续同步；Canvas 恢复下载地址或文件缩小后会自动重试。</p>{failures.map(f=><div key={f.origin+f.origin_key} className="border-t py-2 text-sm"><strong>{f.name}</strong><span className="ml-2 text-xs text-muted-foreground">{courses.find(c=>c.id===f.course_id)?.code||f.course_id}</span><p>{f.error}</p></div>)}</details>}
    <section className="rounded-2xl border bg-card p-5"><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>job('canvas')}>立即同步 Canvas 全部资料</Button><Button variant="outline" onClick={()=>job('piazza')}>同步 Piazza</Button><Button variant="outline" onClick={()=>job('night')}>补齐 PDF 与语义索引</Button><Button variant="outline" onClick={()=>load().catch(e=>setMessage(e.message))}>刷新</Button></div><p className="mt-3 text-sm">后台：{status.worker&&checkedAt-status.worker.heartbeat<90000?'运行中':'未运行或心跳超时'} · AI 月度已用／预留 ${Number(status.budget?.used||0).toFixed(3)} / ${status.budget?.limit??30}</p><p className="mt-2 text-xs text-muted-foreground">Canvas 每 15 分钟自动检查；Piazza 每 30 分钟检查；每天 03:00 补齐失败页与向量索引。无变化不会重复处理或计费。</p></section>
    <details className="rounded-xl border bg-card p-4"><summary>后台任务记录</summary>{status.jobs.map((j:any)=><div key={j.id} className="border-b py-2 text-xs">{j.kind} · {j.status} · 尝试 {j.attempts}{j.error&&<p>{j.error}</p>}{j.status==='failed'&&<button className="underline" onClick={async()=>{await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retry:j.id})});await load();}}>重试</button>}</div>)}</details>
  </div>;
}
