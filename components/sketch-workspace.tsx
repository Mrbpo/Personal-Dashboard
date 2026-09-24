'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, Plus, Send, FileDown, RotateCcw, Trash2 } from 'lucide-react';
import { createSketchDraftSaver, reconcileSketchDraft } from '@/lib/sketch-draft';
import { createSketchPageSaveScheduler } from '@/lib/sketch-page-save';
import { isSketchEditable, planSketchPoll } from '@/lib/sketch-poll';

type Book={id:string;status:string;draft_text:string;revision:number;created_at:string;last_activity_at:string};
type Page={id:string;page_no:number;image_hash:string|null;revision:number};
type Entry={id:string;page_no:number;kind:string;body:string;created_at:string};
type Version={id:string;source_revision:number;created_at:string};
type Snapshot={book:Book;pages:Page[];entries:Entry[];versions:Version[];archive:Array<{id:string;created_at:string;archived_at:string}>};
async function request(payload:Record<string,unknown>){const response=await fetch('/api/sketchbooks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error||'操作未完成');return data;}
async function load(bookId?:string):Promise<Snapshot>{const response=await fetch(`/api/sketchbooks${bookId?`?book=${encodeURIComponent(bookId)}`:''}`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'加载失败');return data;}
function blankCanvas(element:HTMLCanvasElement){const pixels=element.getContext('2d')?.getImageData(0,0,element.width,element.height).data;if(!pixels)return false;for(let i=0;i<pixels.length;i+=4)if(pixels[i]!==255||pixels[i+1]!==253||pixels[i+2]!==248||pixels[i+3]!==255)return false;return true;}

export function SketchWorkspace(){
  const [state,setState]=useState<Snapshot|null>(null),[pageNo,setPageNo]=useState(1),[draft,setDraft]=useState(''),[note,setNote]=useState(''),[tool,setTool]=useState<'pen'|'eraser'>('pen'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[canvasReady,setCanvasReady]=useState(false);
  const canvas=useRef<HTMLCanvasElement>(null),drawing=useRef(false),dirty=useRef(false),readyRef=useRef(false),pendingSaves=useRef(0),loadedCanvasPage=useRef(''),saveChain=useRef<Promise<void>>(Promise.resolve()),pageSaver=useRef<ReturnType<typeof createSketchPageSaveScheduler>|null>(null),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),draftValue=useRef(''),draftRevision=useRef(0),draftSaver=useRef<ReturnType<typeof createSketchDraftSaver>|null>(null),stateRef=useRef<Snapshot|null>(null),pageRef=useRef(1);
  const apply=useCallback((next:Snapshot,revisionAtLoad:number)=>{const merged=reconcileSketchDraft(stateRef.current,next,draftValue.current,revisionAtLoad,draftRevision.current);stateRef.current=merged.snapshot;setState(merged.snapshot);draftValue.current=merged.draft;setDraft(merged.draft);},[]);
  const refresh=useCallback(async(bookId?:string)=>{const revisionAtLoad=draftRevision.current;const next=await load(bookId);apply(next,revisionAtLoad);if(!next.pages.some(p=>p.page_no===pageRef.current)){pageRef.current=next.pages[0]?.page_no||1;setPageNo(pageRef.current);}return next;},[apply]);
  useEffect(()=>{void refresh().catch(e=>setMessage(String(e)));},[refresh]);
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(dirty.current||pendingSaves.current||draftValue.current!==stateRef.current?.book.draft_text){void pageSaver.current?.flush().catch(()=>undefined);event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  useEffect(()=>{const timer=setInterval(()=>{
    const current=stateRef.current;if(!current||current.book.status==='archived'||busy)return;
    const revisionAtLoad=draftRevision.current;
    const hasLocalWork=(snapshot:Snapshot)=>dirty.current||drawing.current||pendingSaves.current>0||draftValue.current!==snapshot.book.draft_text;
    void load().then(async next=>{
      const latest=stateRef.current;if(!latest||latest.book.id!==current.book.id)return;
      let plan=planSketchPoll(latest,next,hasLocalWork(latest));
      if(plan.kind==='inspectCurrent'){
        const old=await load(latest.book.id),still=stateRef.current;
        if(!still||still.book.id!==latest.book.id)return;
        plan=planSketchPoll(still,old,hasLocalWork(still));
      }
      if(plan.kind==='none'||plan.kind==='inspectCurrent')return;
      if(plan.kind==='switch'){pageRef.current=1;setPageNo(1);}
      apply(plan.snapshot,revisionAtLoad);
    }).catch(()=>undefined);
  },60000);return()=>clearInterval(timer);},[apply,busy]);
  useEffect(()=>{
    const ctx=canvas.current?.getContext('2d'),element=canvas.current,current=stateRef.current;
    if(!ctx||!element||!current)return;
    const key=`${current.book.id}:${pageNo}`;
    if(loadedCanvasPage.current===key)return;
    loadedCanvasPage.current=key;readyRef.current=false;setCanvasReady(false);
    ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,element.width,element.height);dirty.current=false;
    const page=current.pages.find(p=>p.page_no===pageNo);
    if(!page?.image_hash){readyRef.current=true;setCanvasReady(true);return;}
    const img=new Image();
    img.onload=()=>{if(loadedCanvasPage.current!==key||pageRef.current!==pageNo)return;ctx.clearRect(0,0,element.width,element.height);ctx.drawImage(img,0,0,element.width,element.height);readyRef.current=true;setCanvasReady(true);};
    img.onerror=()=>{if(loadedCanvasPage.current===key)setMessage('画作未能加载，请刷新后重试');};
    img.src=`/api/sketchbooks?book=${encodeURIComponent(current.book.id)}&image=${pageNo}&v=${page.revision}`;
  },[state?.book.id,pageNo,state?.pages]);
  const persist=useCallback(async()=>{
    const current=stateRef.current,element=canvas.current,number=pageRef.current;
    if(current&&element&&dirty.current&&current.book.status!=='archiving'){
      dirty.current=false;const image=blankCanvas(element)?'':element.toDataURL('image/png'),bookId=current.book.id;
      pendingSaves.current++;
      saveChain.current=saveChain.current.catch(()=>undefined).then(async()=>{
        const latest=stateRef.current;if(!latest||latest.book.id!==bookId)return;const page=latest.pages.find(p=>p.page_no===number);if(!page)return;
        const data=await request({action:'savePage',bookId,pageNo:number,image,revision:page.revision});
        const updated={...latest,pages:latest.pages.map(p=>p.page_no===number?{...p,image_hash:data.hasImage?'saved':null,revision:data.revision}:p)};stateRef.current=updated;setState(updated);
      }).finally(()=>{pendingSaves.current--;});
    }
    try{await saveChain.current;}catch(e){dirty.current=true;setMessage(e instanceof Error?e.message:'保存画作失败');throw e;}
  },[]);
  const scheduledPageSave=useCallback(()=>{
    if(!pageSaver.current)pageSaver.current=createSketchPageSaveScheduler(persist);
    return pageSaver.current;
  },[persist]);
  const flushPage=useCallback(()=>scheduledPageSave().flush(),[scheduledPageSave]);
  useEffect(()=>{
    const save=()=>{void flushPage().catch(()=>undefined);};
    const onVisibility=()=>{if(document.visibilityState==='hidden')save();};
    window.addEventListener('pagehide',save);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{window.removeEventListener('pagehide',save);document.removeEventListener('visibilitychange',onVisibility);save();};
  },[flushPage]);
  const flushDraft=useCallback(async()=>{
    if(draftTimer.current)clearTimeout(draftTimer.current);draftTimer.current=null;
    if(!draftSaver.current)draftSaver.current=createSketchDraftSaver(
      ()=>{const current=stateRef.current;return current?{bookId:current.book.id,status:current.book.status,current:draftValue.current,saved:current.book.draft_text}:null;},
      async(bookId,text)=>{await request({action:'draft',bookId,text});},
      (bookId,text)=>{const latest=stateRef.current;if(!latest||latest.book.id!==bookId)return;draftRevision.current++;const next={...latest,book:{...latest.book,draft_text:text}};stateRef.current=next;setState(next);},
    );
    await draftSaver.current();
  },[]);
  const changeDraft=(value:string)=>{draftRevision.current++;draftValue.current=value;setDraft(value);if(draftTimer.current)clearTimeout(draftTimer.current);draftTimer.current=setTimeout(()=>{void flushDraft().catch(e=>setMessage(String(e)));},650);};
  const move=async(number:number)=>{if(number===pageNo)return;try{await flushPage();await flushDraft();if(stateRef.current?.book.status==='active')await request({action:'touch',bookId:stateRef.current.book.id});pageRef.current=number;setPageNo(number);}catch(e){setMessage(e instanceof Error?e.message:'切页失败');}};
  const action=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await flushPage();await flushDraft();if(stateRef.current?.book.status==='active')await request({action:'touch',bookId:stateRef.current.book.id});await fn();}catch(e){setMessage(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
  const point=(event:React.PointerEvent<HTMLCanvasElement>)=>{const box=event.currentTarget.getBoundingClientRect();return{x:(event.clientX-box.left)*event.currentTarget.width/box.width,y:(event.clientY-box.top)*event.currentTarget.height/box.height};};
  const start=(event:React.PointerEvent<HTMLCanvasElement>)=>{if(!readyRef.current||!isSketchEditable(state?.book.status))return;event.currentTarget.setPointerCapture(event.pointerId);const ctx=event.currentTarget.getContext('2d');if(!ctx)return;scheduledPageSave().pause();drawing.current=true;const p=point(event);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+.01,p.y+.01);ctx.strokeStyle=tool==='eraser'?'#fffdf8':'#1c2930';ctx.lineWidth=tool==='eraser'?24:3;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();dirty.current=true;};
  const draw=(event:React.PointerEvent<HTMLCanvasElement>)=>{if(!drawing.current)return;const ctx=event.currentTarget.getContext('2d');if(!ctx)return;const p=point(event);ctx.lineTo(p.x,p.y);ctx.stroke();dirty.current=true;};
  const stop=()=>{if(!drawing.current)return;drawing.current=false;scheduledPageSave().schedule();};
  const currentPage=state?.pages.find(p=>p.page_no===pageNo),editable=isSketchEditable(state?.book.status);
  return <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
    <section className="min-w-0 space-y-4">
      <div className="rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-3 shadow-sm sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm font-semibold text-[#24323a]">第 {pageNo} 页 · {state?.pages.length||0} 页</span>
          <button type="button" onClick={()=>setTool('pen')} className={`rounded-lg px-3 py-2 text-sm ${tool==='pen'?'bg-[#253b40] text-white':'bg-white text-[#253b40]'}`} aria-label="画笔"><PenLine className="inline size-4"/> 画笔</button>
          <button type="button" onClick={()=>setTool('eraser')} className={`rounded-lg px-3 py-2 text-sm ${tool==='eraser'?'bg-[#253b40] text-white':'bg-white text-[#253b40]'}`} aria-label="橡皮"><Eraser className="inline size-4"/> 橡皮</button>
          <button type="button" disabled={!editable||busy||!canvasReady} onClick={()=>void action(async()=>{const ctx=canvas.current?.getContext('2d');if(ctx&&canvas.current){ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,canvas.current.width,canvas.current.height);dirty.current=true;await flushPage();}})} className="rounded-lg bg-white px-3 py-2 text-sm text-[#253b40] disabled:opacity-50"><RotateCcw className="inline size-4"/> 清空</button>
        </div>
        <canvas ref={canvas} width={1000} height={700} className="block aspect-[10/7] w-full rounded-lg border border-[#d6cfbf] bg-[#fffdf8] touch-none" style={{cursor:editable&&canvasReady?'crosshair':'wait'}} onPointerDown={start} onPointerMove={draw} onPointerUp={stop} onPointerCancel={stop} aria-label={`第 ${pageNo} 页绘图区`}/>
        {!canvasReady&&<p role="status" className="mt-2 text-xs text-[#695f50]">正在载入本页画作…</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">{state?.pages.map(page=><button type="button" key={page.id} onClick={()=>void move(page.page_no)} className={`min-w-10 rounded-md border px-3 py-2 text-sm ${pageNo===page.page_no?'border-[#253b40] bg-[#253b40] text-white':'border-[#c8beaa] bg-white'}`}>{page.page_no}</button>)}<button type="button" disabled={!editable||busy||state?.pages.length===100} onClick={()=>void action(async()=>{if(!state)return;const result=await request({action:'page',bookId:state.book.id});await refresh(state.book.id);pageRef.current=result.pageNo;setPageNo(result.pageNo);})} className="rounded-md border border-dashed border-[#84775e] px-3 py-2 text-sm disabled:opacity-50"><Plus className="inline size-4"/> 新页</button></div>
      </div>
      <div className="rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-5">
        <label htmlFor="sketch-question" className="block text-sm font-semibold">共享文字问题</label><p className="mb-3 mt-1 text-xs text-[#695f50]">切页与提问后仍保留，可随时改写。发送时只附当前页画面。</p>
        <textarea id="sketch-question" value={draft} disabled={!editable} onChange={e=>changeDraft(e.target.value)} maxLength={6000} rows={5} className="w-full rounded-lg border border-[#c8beaa] bg-white p-3 text-sm outline-none focus:border-[#465b5d] disabled:opacity-60" placeholder="写下问题，也可以直接在画布上写字、画图或推导公式。"/>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!editable||busy||!currentPage} onClick={()=>void action(async()=>{if(!state)return;await request({action:'ask',bookId:state.book.id,pageNo,requestId:crypto.randomUUID()});await refresh(state.book.id);})} className="rounded-lg bg-[#253b40] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Send className="mr-1 inline size-4"/> {busy?'处理中…':'发送当前页给 AI'}</button><button type="button" disabled={busy||!state} onClick={()=>void action(async()=>{if(!state)return;const result=await request({action:'pdf',bookId:state.book.id});await refresh(state.book.id);window.open(`/api/sketchbooks?book=${encodeURIComponent(state.book.id)}&pdf=${encodeURIComponent(result.versionId)}`,'_blank','noopener');})} className="rounded-lg border border-[#465b5d] bg-white px-4 py-2.5 text-sm disabled:opacity-50"><FileDown className="mr-1 inline size-4"/> 生成 PDF</button></div>
        {message&&<p role="alert" className="mt-3 text-sm text-[#a03e31]">{message}</p>}
      </div>
    </section>
    <aside className="min-w-0 space-y-5">
      <section className="rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-5"><h2 className="font-semibold">可编辑记录</h2><p className="mt-1 text-xs text-[#695f50]">问题原文、补充文字和每次 AI 回答各自保存；删除或修改后可重新生成 PDF。</p>
        <div className="mt-4 flex gap-2"><input value={note} onChange={e=>setNote(e.target.value)} maxLength={6000} placeholder="补充一段文字" className="min-w-0 flex-1 rounded-lg border border-[#c8beaa] bg-white px-3 py-2 text-sm"/><button type="button" disabled={busy||!note.trim()||!state} onClick={()=>void action(async()=>{if(!state)return;await request({action:'text',bookId:state.book.id,pageNo,body:note});setNote('');await refresh(state.book.id);})} className="rounded-lg bg-[#d9c99e] px-3 py-2 text-sm disabled:opacity-50">添加</button></div>
        <div className="mt-4 max-h-[650px] space-y-3 overflow-y-auto">{state?.entries.length?state.entries.map(entry=><EntryCard key={entry.id} entry={entry} disabled={busy||state.book.status==='archiving'} onSave={body=>action(async()=>{await request({action:'edit',bookId:state.book.id,entryId:entry.id,body});await refresh(state.book.id);})} onDelete={()=>action(async()=>{await request({action:'delete',bookId:state.book.id,entryId:entry.id});await refresh(state.book.id);})}/>):<p className="text-sm text-[#695f50]">还没有记录。</p>}</div>
      </section>
      <section className="rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-5"><h2 className="font-semibold">PDF 版本与归档</h2><p className="mt-1 text-xs text-[#695f50]">连续两小时无动作后，服务器会生成 PDF 并归档此画册。成功后自动启用新画册。</p><div className="mt-3 space-y-2">{state?.versions.map(v=><a key={v.id} target="_blank" rel="noreferrer" className="block text-sm text-[#315b68] underline" href={`/api/sketchbooks?book=${encodeURIComponent(state.book.id)}&pdf=${encodeURIComponent(v.id)}`}>{new Date(v.created_at).toLocaleString('zh-CN')} · 版本 {v.source_revision}</a>)}</div><h3 className="mt-5 text-sm font-semibold">历史画册</h3><div className="mt-2 space-y-2">{state?.archive.map(book=><button type="button" key={book.id} onClick={()=>void action(async()=>{await refresh(book.id);pageRef.current=1;setPageNo(1);})} className="block text-left text-sm text-[#315b68] underline">{new Date(book.created_at).toLocaleString('zh-CN')} 的画册</button>)}</div>{state?.book.status==='archived'&&<button type="button" onClick={()=>void action(async()=>{pageRef.current=1;setPageNo(1);await refresh();})} className="mt-4 rounded-lg bg-[#253b40] px-3 py-2 text-sm text-white">返回当前画册</button>}</section>
    </aside>
  </div>;
}
function EntryCard({entry,disabled,onSave,onDelete}:{entry:Entry;disabled:boolean;onSave:(body:string)=>Promise<void>;onDelete:()=>Promise<void>}){const [text,setText]=useState(entry.body);useEffect(()=>setText(entry.body),[entry.body]);return <article className="rounded-lg border border-[#d4c9b5] bg-white p-3"><div className="mb-2 flex items-center justify-between text-xs text-[#736c60]"><span>第 {entry.page_no} 页 · {entry.kind==='answer'?'AI 回答':entry.kind==='question'?'问题原文':'补充文字'}</span><button type="button" disabled={disabled} onClick={()=>void onDelete()} aria-label="删除记录" className="text-[#9b4b3d] disabled:opacity-50"><Trash2 className="size-4"/></button></div><textarea value={text} onChange={e=>setText(e.target.value)} disabled={disabled} rows={Math.min(12,Math.max(3,Math.ceil(text.length/45)))} className="w-full resize-y rounded-md border border-[#e6dfd2] p-2 text-sm leading-6 disabled:opacity-60"/><button type="button" disabled={disabled||text===entry.body} onClick={()=>void onSave(text)} className="mt-2 rounded-md bg-[#e9e1cf] px-3 py-1 text-xs disabled:opacity-50">保存修改</button></article>;}
