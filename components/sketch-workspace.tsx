'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, Plus, Send, FileDown, RotateCcw, Trash2, Undo2, Redo2, Slash, Circle, Square, MousePointer2, PanelRightClose, ChevronLeft, ChevronRight } from 'lucide-react';
import { createSketchDraftSaver, reconcileSketchDraft } from '@/lib/sketch-draft';
import { createSketchPageSaveScheduler } from '@/lib/sketch-page-save';
import { isSketchEditable, planSketchPoll, shouldRetrySketchPageSave } from '@/lib/sketch-poll';
import { annotationShortcut, isPenEraser } from '@/lib/pdf-input';
import { drawSketchStroke, hitSketchTrail, eraserDisplayRadius, SKETCH_WIDTH, SKETCH_HEIGHT, ERASER_RADIUS, type SketchPoint, type SketchStroke, type SketchTool } from '@/lib/sketch-ink';

type Book={id:string;status:string;draft_text:string;revision:number;created_at:string;last_activity_at:string};
type Page={id:string;page_no:number;image_hash:string|null;base_image_hash:string|null;cleared_image_hash:string|null;strokes:SketchStroke[]|null;revision:number;note_draft:string;note_revision:number};
type Entry={id:string;page_no:number;kind:string;body:string;edit_revision:number;created_at:string};
type Version={id:string;source_revision:number;created_at:string};
type Snapshot={book:Book;pages:Page[];entries:Entry[];versions:Version[];archive:Array<{id:string;created_at:string;archived_at:string}>};
async function request(payload:Record<string,unknown>){const response=await fetch('/api/sketchbooks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error||'操作未完成');return data;}
async function load(bookId?:string):Promise<Snapshot>{const response=await fetch(`/api/sketchbooks${bookId?`?book=${encodeURIComponent(bookId)}`:''}`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'加载失败');return data;}
function canvasPng(element:HTMLCanvasElement):Promise<string>{return new Promise((resolve,reject)=>element.toBlob(blob=>{if(!blob){reject(new Error('画作编码失败'));return;}const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('画作编码失败'));reader.readAsDataURL(blob);},'image/png'));}
const pageBackupKey=(bookId:string,pageNo:number)=>`sketch-page:${bookId}:${pageNo}`;
function lastPage(bookId:string){try{return Number(localStorage.getItem(`sketch-last-page:${bookId}`)||1);}catch{return 1;}}
function rememberPage(bookId:string,pageNo:number){try{localStorage.setItem(`sketch-last-page:${bookId}`,String(pageNo));}catch{}}
function putBackup(key:string,value:unknown){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function getBackup<T>(key:string):T|null{try{return JSON.parse(localStorage.getItem(key)||'null') as T;}catch{return null;}}
function clearBackup(key:string){try{localStorage.removeItem(key);}catch{}}

export function SketchWorkspace(){
  const [state,setState]=useState<Snapshot|null>(null),[pageNo,setPageNo]=useState(1),[draft,setDraft]=useState(''),[tool,setTool]=useState<SketchTool>('pen'),[color,setColor]=useState('#1c2930'),[thickness,setThickness]=useState(3),[tabletMode,setTabletMode]=useState(false),[panel,setPanel]=useState<'question'|'records'|'history'|null>('question'),[inkUi,setInkUi]=useState({undo:0,redo:0,strokes:0}),[eraserPoint,setEraserPoint]=useState<SketchPoint|null>(null),[eraserCssRadius,setEraserCssRadius]=useState(ERASER_RADIUS),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[canvasReady,setCanvasReady]=useState(false),[pageConflict,setPageConflict]=useState(false),[saveStatus,setSaveStatus]=useState<'saved'|'pending'|'failed'>('saved');
  const canvas=useRef<HTMLCanvasElement>(null),drawing=useRef(false),dirty=useRef(false),hasMarks=useRef(false),readyRef=useRef(false),pendingSaves=useRef(0),pageSaveError=useRef(''),loadedCanvasPage=useRef(''),saveChain=useRef<Promise<void>>(Promise.resolve()),pageSaver=useRef<ReturnType<typeof createSketchPageSaveScheduler>|null>(null),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),draftValue=useRef(''),draftRevision=useRef(0),draftSaver=useRef<ReturnType<typeof createSketchDraftSaver>|null>(null),stateRef=useRef<Snapshot|null>(null),pageRef=useRef(1);
  const strokes=useRef<SketchStroke[]>([]),undoStack=useRef<SketchStroke[][]>([]),redoStack=useRef<SketchStroke[][]>([]),baseImage=useRef<HTMLImageElement|null>(null),legacyBackup=useRef(false),active=useRef<{pointerId:number;tool:SketchTool;before:SketchStroke[];last:SketchPoint;erase:Set<string>}|null>(null),hoverIds=useRef(new Set<string>());
  const repaint=useCallback(()=>{const ctx=canvas.current?.getContext('2d');if(!ctx)return;ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,SKETCH_WIDTH,SKETCH_HEIGHT);if(baseImage.current)ctx.drawImage(baseImage.current,0,0,SKETCH_WIDTH,SKETCH_HEIGHT);for(const stroke of strokes.current)drawSketchStroke(ctx,stroke,hoverIds.current.has(stroke.id));},[]);
  const updateInkUi=()=>setInkUi({undo:undoStack.current.length,redo:redoStack.current.length,strokes:strokes.current.length});
  useEffect(()=>{const preference=localStorage.getItem('sketch-tablet-mode');if(preference==='on'||preference===null&&window.matchMedia('(pointer: coarse) and (max-width: 1280px)').matches){setTabletMode(true);setPanel(null);}},[]);
  const apply=useCallback((next:Snapshot,revisionAtLoad:number)=>{const merged=reconcileSketchDraft(stateRef.current,next,draftValue.current,revisionAtLoad,draftRevision.current);stateRef.current=merged.snapshot;setState(merged.snapshot);draftValue.current=merged.draft;setDraft(merged.draft);const backup=getBackup<{text:string;expected:string}>(`sketch-draft:${next.book.id}`);if(backup&&backup.text!==next.book.draft_text){draftValue.current=backup.text;setDraft(backup.text);setSaveStatus(backup.expected===next.book.draft_text?'pending':'failed');}},[]);
  const refresh=useCallback(async(bookId?:string)=>{const revisionAtLoad=draftRevision.current,previousId=stateRef.current?.book.id;const next=await load(bookId);apply(next,revisionAtLoad);if(previousId!==next.book.id){const remembered=lastPage(next.book.id);pageRef.current=next.pages.some(p=>p.page_no===remembered)?remembered:next.pages[0]?.page_no||1;setPageNo(pageRef.current);}else if(!next.pages.some(p=>p.page_no===pageRef.current)){pageRef.current=next.pages[0]?.page_no||1;setPageNo(pageRef.current);}return next;},[apply]);
  useEffect(()=>{void refresh().catch(e=>setMessage(String(e)));},[refresh]);
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(drawing.current||dirty.current||pendingSaves.current||draftValue.current!==stateRef.current?.book.draft_text){if(!drawing.current)void pageSaver.current?.flush().catch(()=>undefined);void draftSaver.current?.().catch(()=>undefined);event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
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
      if(plan.kind==='apply'&&shouldRetrySketchPageSave(plan.snapshot.book.status,dirty.current,drawing.current))pageSaver.current?.schedule();
    }).catch(()=>undefined);
  },60000);return()=>clearInterval(timer);},[apply,busy]);
  useEffect(()=>{
    const element=canvas.current,current=stateRef.current;if(!element||!current)return;
    const key=`${current.book.id}:${pageNo}`;if(loadedCanvasPage.current===key)return;
    loadedCanvasPage.current=key;readyRef.current=false;setCanvasReady(false);setPageConflict(false);dirty.current=false;hasMarks.current=false;
    strokes.current=[];undoStack.current=[];redoStack.current=[];baseImage.current=null;legacyBackup.current=false;hoverIds.current.clear();repaint();setInkUi({undo:0,redo:0,strokes:0});
    const page=current.pages.find(p=>p.page_no===pageNo);
    const backup=getBackup<{image:string;revision:number;strokes?:SketchStroke[]}>(pageBackupKey(current.book.id,pageNo));
    if(backup&&backup.revision!==page?.revision){setMessage('本页在其他窗口更改；本机画作备份仍保留，请先下载核对');setSaveStatus('failed');setPageConflict(true);}
    const canRecover=Boolean(backup&&backup.revision===page?.revision&&(backup.strokes!==undefined||page?.strokes===null));
    if(backup&&backup.revision===page?.revision&&!canRecover){setMessage('旧版位图备份与逐笔画页不兼容；备份仍保留，请先下载核对');setSaveStatus('failed');setPageConflict(true);}
    const finish=()=>{if(loadedCanvasPage.current!==key)return;strokes.current=canRecover&&backup?.strokes!==undefined?backup.strokes:page?.strokes||[];hasMarks.current=Boolean(baseImage.current||strokes.current.length);repaint();setInkUi({undo:0,redo:0,strokes:strokes.current.length});if(canRecover){dirty.current=true;setSaveStatus('pending');pageSaver.current?.schedule();}readyRef.current=true;setCanvasReady(true);};
    if(canRecover&&backup?.strokes===undefined){legacyBackup.current=true;if(!backup?.image){finish();return;}const img=new Image();img.onload=()=>{if(loadedCanvasPage.current!==key)return;baseImage.current=img;finish();};img.src=backup.image;return;}
    const background=page?.strokes===null?page?.image_hash:page?.base_image_hash;
    if(!background){finish();return;}
    const img=new Image();img.onload=()=>{if(loadedCanvasPage.current!==key)return;baseImage.current=img;finish();};img.onerror=()=>{if(loadedCanvasPage.current===key)setMessage('画作未能加载，请刷新后重试');};
    img.src=`/api/sketchbooks?book=${encodeURIComponent(current.book.id)}&${page?.strokes===null?'image':'base'}=${pageNo}&v=${page?.revision}`;
  },[state?.book.id,pageNo,state?.pages,repaint]);
  const persist=useCallback(async()=>{
    const current=stateRef.current,number=pageRef.current;
    if(current&&canvas.current&&dirty.current&&current.book.status!=='archiving'){
      dirty.current=false;const bookId=current.book.id;
      setSaveStatus('pending');
      pendingSaves.current++;
      saveChain.current=saveChain.current.catch(()=>undefined).then(async()=>{
        const latest=stateRef.current;if(!latest||latest.book.id!==bookId)return;const page=latest.pages.find(p=>p.page_no===number);if(!page)return;
        if(drawing.current){dirty.current=true;return;}
        const savedStrokes=strokes.current.map(stroke=>({...stroke,points:[...stroke.points]}));
        const snapshot=document.createElement('canvas');snapshot.width=SKETCH_WIDTH;snapshot.height=SKETCH_HEIGHT;
        const ctx=snapshot.getContext('2d');if(!ctx)throw new Error('画布不可用');
        ctx.fillStyle='#fffdf8';ctx.fillRect(0,0,SKETCH_WIDTH,SKETCH_HEIGHT);
        if(baseImage.current)ctx.drawImage(baseImage.current,0,0,SKETCH_WIDTH,SKETCH_HEIGHT);
        for(const stroke of savedStrokes)drawSketchStroke(ctx,stroke);
        const image=baseImage.current||savedStrokes.length?await canvasPng(snapshot):'';
        const wasLegacyBackup=legacyBackup.current;
        if(!putBackup(pageBackupKey(bookId,number),{image,revision:page.revision,...(wasLegacyBackup?{}:{strokes:savedStrokes})}))setMessage('本机画作备份空间不足，请保持页面打开直到保存成功');
        const data=await request({action:'savePage',bookId,pageNo:number,image,revision:page.revision,...(wasLegacyBackup?{}:{strokes:savedStrokes})});
        const backup=getBackup<{image:string}>(pageBackupKey(bookId,number));if(backup?.image===image&&!dirty.current)clearBackup(pageBackupKey(bookId,number));
        const updated={...latest,pages:latest.pages.map(p=>p.page_no===number?{...p,image_hash:data.hasImage?'saved':null,base_image_hash:wasLegacyBackup?p.base_image_hash:p.strokes===null?p.image_hash:p.base_image_hash,strokes:wasLegacyBackup?null:savedStrokes,revision:data.revision}:p)};stateRef.current=updated;setState(updated);legacyBackup.current=false;
        if(!dirty.current&&draftValue.current===updated.book.draft_text)setSaveStatus('saved');
        if(pageSaveError.current){const error=pageSaveError.current;pageSaveError.current='';setMessage(message=>message===error?'':message);}
      }).finally(()=>{pendingSaves.current--;});
    }
    try{await saveChain.current;}catch(e){dirty.current=true;const error=e instanceof Error?e.message:'保存画作失败';pageSaveError.current=error;setMessage(error);setSaveStatus('failed');if(error.includes('其他窗口'))setPageConflict(true);else setTimeout(()=>{if(dirty.current&&!drawing.current)pageSaver.current?.schedule();},3000);throw e;}
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
      async(bookId,text,expected)=>{setSaveStatus('pending');await request({action:'draft',bookId,text,expected});},
      (bookId,text)=>{const latest=stateRef.current;if(!latest||latest.book.id!==bookId)return;draftRevision.current++;const next={...latest,book:{...latest.book,draft_text:text}};stateRef.current=next;setState(next);if(draftValue.current===text){clearBackup(`sketch-draft:${bookId}`);setSaveStatus('saved');}else putBackup(`sketch-draft:${bookId}`,{text:draftValue.current,expected:text});},
    );
    try{await draftSaver.current();}catch(e){setSaveStatus('failed');throw e;}
  },[]);
  useEffect(()=>{const current=stateRef.current;if(!current)return;const backup=getBackup<{text:string;expected:string}>(`sketch-draft:${current.book.id}`);if(backup&&backup.expected===current.book.draft_text&&backup.text!==backup.expected)void flushDraft().catch(()=>undefined);},[state?.book.id,flushDraft]);
  const changeDraft=(value:string)=>{draftRevision.current++;draftValue.current=value;setDraft(value);setSaveStatus('pending');const current=stateRef.current;if(current)putBackup(`sketch-draft:${current.book.id}`,{text:value,expected:current.book.draft_text});if(draftTimer.current)clearTimeout(draftTimer.current);draftTimer.current=setTimeout(()=>{void flushDraft().catch(e=>{setMessage(String(e));if(!String(e).includes('其他窗口'))setTimeout(()=>void flushDraft().catch(()=>undefined),3000);});},650);};
  const move=async(number:number)=>{if(number===pageNo)return;if(drawing.current){setMessage('请先完成当前笔画再切页');return;}try{await flushPage();await flushDraft();if(stateRef.current?.book.status==='active')await request({action:'touch',bookId:stateRef.current.book.id});if(stateRef.current)rememberPage(stateRef.current.book.id,number);pageRef.current=number;setPageNo(number);}catch(e){setMessage(e instanceof Error?e.message:'切页失败');}};
  const action=async(fn:()=>Promise<void>)=>{if(drawing.current){setMessage('请先完成当前笔画再操作');return;}setBusy(true);setMessage('');try{await flushPage();await flushDraft();if(stateRef.current?.book.status==='active')await request({action:'touch',bookId:stateRef.current.book.id});await fn();}catch(e){setMessage(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
  const point=(event:React.PointerEvent<HTMLCanvasElement>):SketchPoint=>{const box=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))};};
  const commit=(before:SketchStroke[])=>{undoStack.current=[...undoStack.current.slice(-49),before];redoStack.current=[];dirty.current=true;hasMarks.current=Boolean(baseImage.current||strokes.current.length);setSaveStatus('pending');repaint();updateInkUi();scheduledPageSave().schedule();};
  const markErase=(from:SketchPoint,to:SketchPoint,selected:Set<string>)=>{for(const id of hitSketchTrail(strokes.current,from,to))selected.add(id);hoverIds.current=new Set(selected);repaint();};
  const start=(event:React.PointerEvent<HTMLCanvasElement>)=>{
    const selectedTool=isPenEraser(event)?'eraser':tool;
    if(!readyRef.current||pageConflict||!isSketchEditable(state?.book.status)||active.current||selectedTool==='view'||event.pointerType==='mouse'&&event.button!==0||event.pointerType==='pen'&&event.button!==0&&selectedTool!=='eraser')return;
    if(selectedTool!=='eraser'&&(strokes.current.length>=1000||strokes.current.reduce((n,s)=>n+s.points.length,0)>=30000)){setMessage('本页笔画已达上限，请先擦除一些内容');return;}
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);scheduledPageSave().pause();drawing.current=true;
    const p=point(event),before=strokes.current.map(s=>({...s,points:[...s.points]}));
    active.current={pointerId:event.pointerId,tool:selectedTool,before,last:p,erase:new Set()};
    if(selectedTool==='eraser'){setEraserCssRadius(eraserDisplayRadius(event.currentTarget.getBoundingClientRect().width));setEraserPoint(p);markErase(p,p,active.current.erase);return;}
    const stroke:SketchStroke={id:crypto.randomUUID(),color,width:thickness/SKETCH_WIDTH,points:selectedTool==='pen'?[p]:[p,p],...(selectedTool==='pen'?{}:{shape:selectedTool})};strokes.current=[...strokes.current,stroke];if(selectedTool==='pen'){const ctx=canvas.current?.getContext('2d');if(ctx)drawSketchStroke(ctx,stroke);}else repaint();
  };
  const draw=(event:React.PointerEvent<HTMLCanvasElement>)=>{
    const p=point(event),gesture=active.current;
    if(!gesture||gesture.pointerId!==event.pointerId){if(readyRef.current&&(tool==='eraser'||isPenEraser(event))){setEraserCssRadius(eraserDisplayRadius(event.currentTarget.getBoundingClientRect().width));setEraserPoint(p);hoverIds.current=hitSketchTrail(strokes.current,p,p);repaint();}else if(hoverIds.current.size||eraserPoint){hoverIds.current.clear();setEraserPoint(null);repaint();}return;}
    event.preventDefault();if(gesture.tool==='eraser'){setEraserCssRadius(eraserDisplayRadius(event.currentTarget.getBoundingClientRect().width));setEraserPoint(p);markErase(gesture.last,p,gesture.erase);gesture.last=p;return;}
    const last=strokes.current.at(-1);if(!last)return;
    if(gesture.tool==='pen'){if(last.points.length>=3000)return;const d=Math.hypot((p.x-gesture.last.x)*SKETCH_WIDTH,(p.y-gesture.last.y)*SKETCH_HEIGHT);if(d<1)return;const previous=gesture.last;last.points.push(p);const ctx=canvas.current?.getContext('2d');if(ctx)drawSketchStroke(ctx,{...last,points:[previous,p]});}else{last.points[1]=p;repaint();}
    gesture.last=p;
  };
  const stop=(event?:React.PointerEvent<HTMLCanvasElement>,cancel=false)=>{const gesture=active.current;if(!gesture||event&&event.pointerId!==gesture.pointerId)return;active.current=null;drawing.current=false;setEraserPoint(null);hoverIds.current.clear();
    if(cancel){strokes.current=gesture.before;repaint();return;}
    if(gesture.tool==='eraser'){if(gesture.erase.size){strokes.current=strokes.current.filter(stroke=>!gesture.erase.has(stroke.id));commit(gesture.before);}else repaint();return;}
    const last=strokes.current.at(-1),short=last?.shape&&Math.hypot((last.points[1].x-last.points[0].x)*SKETCH_WIDTH,(last.points[1].y-last.points[0].y)*SKETCH_HEIGHT)<3;
    if(short){strokes.current=gesture.before;repaint();return;}commit(gesture.before);
  };
  const undoRedo=(direction:'undo'|'redo')=>{if(!readyRef.current||pageConflict||drawing.current)return;const source=direction==='undo'?undoStack:redoStack,target=direction==='undo'?redoStack:undoStack;if(!source.current.length)return;target.current=[...target.current.slice(-49),strokes.current];strokes.current=source.current.at(-1)!;source.current=source.current.slice(0,-1);dirty.current=true;hasMarks.current=Boolean(baseImage.current||strokes.current.length);setSaveStatus('pending');repaint();updateInkUi();scheduledPageSave().schedule();};
  useEffect(()=>{const listener=(event:KeyboardEvent)=>{if(event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable]'))return;const direction=annotationShortcut(event);if(direction&&readyRef.current&&!pageConflict){event.preventDefault();undoRedo(direction);}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);});
  const currentPage=state?.pages.find(p=>p.page_no===pageNo),editable=isSketchEditable(state?.book.status);
  const toolButton=(name:SketchTool,label:string,icon:React.ReactNode)=><button type="button" key={name} disabled={!editable||busy} onClick={()=>setTool(name)} aria-label={label} aria-pressed={tool===name} title={label} className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-xl px-2 text-sm ${tool===name?'bg-[#253b40] text-white':'bg-white text-[#253b40]'}`}>{icon}<span className="hidden 2xl:inline">{label}</span></button>;
  return <div className={tabletMode?'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#e9e3d5] p-2 text-[#24323a] sm:p-3':'grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]'}>
    <section className={tabletMode?'flex min-h-0 min-w-0 flex-1 flex-col':'min-w-0 space-y-4'}>
      <div className={tabletMode?'flex min-h-0 flex-1 flex-col rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-2 shadow-sm':'rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-3 shadow-sm sm:p-5'}>
        <div className={tabletMode?'mb-2 flex shrink-0 items-center gap-1.5 overflow-x-auto [&>*]:shrink-0':'mb-2 flex flex-wrap items-center gap-1.5'}>
          <button type="button" onClick={()=>{localStorage.setItem('sketch-tablet-mode',tabletMode?'off':'on');setTabletMode(!tabletMode);setPanel(null);}} className="min-h-11 rounded-xl border bg-white px-3 text-sm font-semibold">{tabletMode?'退出平板模式':'平板模式'}</button>
          <span className="mr-auto whitespace-nowrap text-sm font-semibold">第 {pageNo} / {state?.pages.length||0} 页</span>
          {toolButton('view','查看',<MousePointer2 className="size-5"/>)}
          {toolButton('pen','画笔',<PenLine className="size-5"/>)}
          {toolButton('eraser','整笔橡皮',<Eraser className="size-5"/>)}
          {toolButton('line','直线',<Slash className="size-5"/>)}
          {toolButton('circle','圆形',<Circle className="size-5"/>)}
          {toolButton('rectangle','矩形',<Square className="size-5"/>)}
          <button type="button" disabled={!editable||!inkUi.undo||pageConflict} onClick={()=>undoRedo('undo')} aria-label="撤销" title="撤销" className="min-h-11 min-w-11 rounded-xl bg-white disabled:opacity-40"><Undo2 className="mx-auto size-5"/></button>
          <button type="button" disabled={!editable||!inkUi.redo||pageConflict} onClick={()=>undoRedo('redo')} aria-label="重做" title="重做" className="min-h-11 min-w-11 rounded-xl bg-white disabled:opacity-40"><Redo2 className="mx-auto size-5"/></button>
          <label className="flex min-h-11 items-center gap-1 rounded-xl bg-white px-2 text-xs">颜色<input type="color" value={color} onChange={event=>setColor(event.target.value)} aria-label="笔画颜色" className="size-8"/></label>
          <label className="flex min-h-11 items-center gap-1 rounded-xl bg-white px-2 text-xs">粗细<select value={thickness} onChange={event=>setThickness(Number(event.target.value))} aria-label="笔画粗细" className="min-h-9 bg-white text-sm">{[2,3,5,8,12,20].map(size=><option key={size} value={size}>{size}</option>)}</select></label>
          <button type="button" disabled={!editable||busy||!canvasReady||pageConflict||!inkUi.strokes} onClick={()=>{if(window.confirm('清除本页新增的全部笔画？历史 PNG 底图会保留。')){const before=strokes.current;strokes.current=[];commit(before);}}} className="min-h-11 rounded-xl bg-white px-3 text-sm disabled:opacity-40"><RotateCcw className="inline size-4"/> 清除新笔画</button>
          <button type="button" disabled={!editable||busy||!canvasReady||pageConflict||!currentPage?.image_hash} onClick={()=>{if(window.confirm('清空整页画面？此操作会保存一份可恢复的前一版画面；已生成的 PDF 不受影响。'))void action(async()=>{const current=stateRef.current,page=current?.pages.find(p=>p.page_no===pageRef.current);if(!current||!page)return;await request({action:'clearPage',bookId:current.book.id,pageNo:pageRef.current,revision:page.revision});loadedCanvasPage.current='';await refresh(current.book.id);});}} className="min-h-11 rounded-xl border border-[#a77d69] bg-white px-3 text-sm disabled:opacity-40">清空整页</button>
          {currentPage?.cleared_image_hash&&!currentPage.image_hash&&<button type="button" disabled={!editable||busy||!canvasReady||pageConflict||Boolean(inkUi.strokes)} onClick={()=>void action(async()=>{const current=stateRef.current,page=current?.pages.find(p=>p.page_no===pageRef.current);if(!current||!page)return;await request({action:'restorePage',bookId:current.book.id,pageNo:pageRef.current,revision:page.revision});loadedCanvasPage.current='';await refresh(current.book.id);})} className="min-h-11 rounded-xl border border-[#a77d69] bg-white px-3 text-sm">恢复清空前画面</button>}
        </div>
        <div className={tabletMode?'relative flex min-h-0 flex-1 items-start justify-center overflow-auto rounded-xl bg-[#d9d1c1] p-1':'relative'}>
          <div className={tabletMode?'relative aspect-[10/7] max-h-full max-w-full shadow-lg':'relative'} style={tabletMode?{width:'min(100%, calc((100dvh - 220px) * 10 / 7))'}:undefined}>
            <canvas ref={canvas} width={SKETCH_WIDTH} height={SKETCH_HEIGHT} className="block aspect-[10/7] w-full rounded-lg border border-[#d6cfbf] bg-[#fffdf8]" style={{cursor:editable&&canvasReady?tool==='view'?'grab':tool==='eraser'?'none':'crosshair':'wait',touchAction:tool==='view'?'auto':'none'}} onPointerEnter={event=>{if(event.pointerType==='pen')event.currentTarget.style.touchAction='none';}} onPointerDown={start} onPointerMove={draw} onPointerUp={event=>stop(event)} onPointerCancel={event=>stop(event,true)} onPointerLeave={event=>{event.currentTarget.style.touchAction=tool==='view'?'auto':'none';if(!active.current){setEraserPoint(null);hoverIds.current.clear();repaint();}}} aria-label={`第 ${pageNo} 页绘图区`}/>
            {eraserPoint&&<span aria-hidden="true" className="pointer-events-none absolute rounded-full border-2 border-[#df684d] bg-[#df684d]/20" style={{left:`${eraserPoint.x*100}%`,top:`${eraserPoint.y*100}%`,width:eraserCssRadius*2,height:eraserCssRadius*2,transform:'translate(-50%,-50%)'}}/>}
          </div>
        </div>
        {!canvasReady&&<p role="status" className="mt-2 text-xs text-[#695f50]">正在载入本页画作…</p>}
        <div className="mt-2 flex min-h-11 items-center gap-2 overflow-x-auto"><button type="button" disabled={pageNo<=1} onClick={()=>void move(pageNo-1)} aria-label="上一页" className="min-h-11 min-w-11 rounded-lg bg-white disabled:opacity-40"><ChevronLeft className="mx-auto size-5"/></button>{state?.pages.map(page=><button type="button" key={page.id} onClick={()=>void move(page.page_no)} aria-current={pageNo===page.page_no?'page':undefined} className={`min-h-11 min-w-11 shrink-0 rounded-lg border text-sm ${pageNo===page.page_no?'border-[#253b40] bg-[#253b40] text-white':'border-[#c8beaa] bg-white'}`}>{page.page_no}</button>)}<button type="button" disabled={pageNo>=(state?.pages.length||0)} onClick={()=>void move(pageNo+1)} aria-label="下一页" className="min-h-11 min-w-11 rounded-lg bg-white disabled:opacity-40"><ChevronRight className="mx-auto size-5"/></button><button type="button" disabled={!editable||busy||state?.pages.length===100} onClick={()=>void action(async()=>{if(!state)return;const result=await request({action:'page',bookId:state.book.id});await refresh(state.book.id);rememberPage(state.book.id,result.pageNo);pageRef.current=result.pageNo;setPageNo(result.pageNo);})} className="min-h-11 shrink-0 rounded-lg border border-dashed border-[#84775e] px-3 text-sm disabled:opacity-50"><Plus className="inline size-4"/> 新页</button></div>
        {currentPage?.strokes===null&&currentPage.image_hash&&<p className="mt-1 text-xs text-[#815b34]">旧画为 PNG 底图，无法识别其中单笔；整笔橡皮只擦除新画的笔画，旧画会保留。</p>}
      </div>
      {tabletMode&&<div className="flex shrink-0 gap-2 overflow-x-auto py-2"><button type="button" onClick={()=>setPanel(panel==='question'?null:'question')} className="min-h-11 shrink-0 rounded-xl bg-white px-4 text-sm font-semibold">文字与提问</button><button type="button" onClick={()=>setPanel(panel==='records'?null:'records')} className="min-h-11 shrink-0 rounded-xl bg-white px-4 text-sm font-semibold">AI 记录</button><button type="button" onClick={()=>setPanel(panel==='history'?null:'history')} className="min-h-11 shrink-0 rounded-xl bg-white px-4 text-sm font-semibold">PDF 与历史</button><button type="button" onClick={()=>setPanel(null)} aria-label="收起面板" className="min-h-11 min-w-11 rounded-xl bg-white"><PanelRightClose className="mx-auto size-5"/></button><span className="ml-auto self-center whitespace-nowrap text-xs">{saveStatus==='saved'?'已保存':saveStatus==='pending'?'正在保存':'保存失败'}</span></div>}
      <div className={`${tabletMode?'absolute inset-x-2 bottom-16 z-10 max-h-[46dvh] overflow-y-auto shadow-xl sm:inset-x-auto sm:right-3 sm:top-20 sm:bottom-auto sm:w-[min(360px,42vw)] sm:max-h-[calc(100dvh-160px)] ':''}rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-5 ${tabletMode&&panel!=='question'?'hidden':''}`}>
        <label htmlFor="sketch-question" className="block text-sm font-semibold">共享文字问题</label><p className="mb-3 mt-1 text-xs text-[#695f50]">切页与提问后仍保留，可随时改写。发送时只附当前页画面。</p>
        <textarea id="sketch-question" value={draft} disabled={!editable} onChange={e=>changeDraft(e.target.value)} maxLength={6000} rows={5} className="w-full rounded-lg border border-[#c8beaa] bg-white p-3 text-sm outline-none focus:border-[#465b5d] disabled:opacity-60" placeholder="写下问题，也可以直接在画布上写字、画图或推导公式。"/>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!editable||busy||!currentPage} onClick={()=>void action(async()=>{if(!state)return;await request({action:'ask',bookId:state.book.id,pageNo,requestId:crypto.randomUUID()});await refresh(state.book.id);})} className="rounded-lg bg-[#253b40] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Send className="mr-1 inline size-4"/> {busy?'处理中…':'发送当前页给 AI'}</button><button type="button" disabled={busy||!state} onClick={()=>void action(async()=>{if(!state)return;const result=await request({action:'pdf',bookId:state.book.id});await refresh(state.book.id);window.open(`/api/sketchbooks?book=${encodeURIComponent(state.book.id)}&pdf=${encodeURIComponent(result.versionId)}`,'_blank','noopener');})} className="rounded-lg border border-[#465b5d] bg-white px-4 py-2.5 text-sm disabled:opacity-50"><FileDown className="mr-1 inline size-4"/> 生成 PDF</button></div>
        <p role="status" className="mt-3 text-xs text-[#695f50]">{saveStatus==='saved'?'画作与共享文字已保存':saveStatus==='pending'?'正在保存画作或共享文字…':'保存失败；本机草稿保留，请重试或复制内容'}</p>
        {saveStatus==='failed'&&<><button type="button" onClick={()=>{void flushPage().catch(()=>undefined);void flushDraft().catch(()=>undefined);}} className="mt-2 rounded-md border px-2 py-1 text-xs">重试保存</button><button type="button" onClick={()=>void navigator.clipboard.writeText(draftValue.current)} className="ml-2 text-xs underline">复制共享文字</button><button type="button" onClick={()=>{if(state){clearBackup(`sketch-draft:${state.book.id}`);window.location.reload();}}} className="ml-2 text-xs underline">载入服务器版本</button></>}
        {state&&getBackup<{image:string}>(pageBackupKey(state.book.id,pageNo))?.image&&<a className="ml-2 text-xs underline" download={`sketch-${pageNo}.png`} href={getBackup<{image:string}>(pageBackupKey(state.book.id,pageNo))?.image}>下载本页画作备份</a>}
        {pageConflict&&state&&<button type="button" onClick={()=>{clearBackup(pageBackupKey(state.book.id,pageNo));window.location.reload();}} className="ml-2 text-xs underline">载入服务器画作</button>}
        {message&&<p role="alert" className="mt-3 text-sm text-[#a03e31]">{message}</p>}
      </div>
    </section>
    <aside className={tabletMode?'contents':'min-w-0 space-y-5'}>
      <section className={`${tabletMode?'absolute inset-x-2 bottom-16 z-10 max-h-[46dvh] overflow-y-auto shadow-xl sm:inset-x-auto sm:right-3 sm:top-20 sm:bottom-auto sm:w-[min(400px,42vw)] sm:max-h-[calc(100dvh-160px)] ':''}rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-5 ${tabletMode&&panel!=='records'?'hidden':''}`}><h2 className="font-semibold">可编辑记录</h2><p className="mt-1 text-xs text-[#695f50]">问题原文、补充文字和每次 AI 回答各自保存；删除或修改后可重新生成 PDF。</p>
        {state&&currentPage&&<AutoSavedText key={`note:${state.book.id}:${pageNo}`} storageKey={`sketch-note:${state.book.id}:${pageNo}`} initial={currentPage.note_draft} revision={currentPage.note_revision} disabled={!editable||busy} maxLength={6000} placeholder="补充一段文字" onSave={async(text,revision)=>{const result=await request({action:'noteDraft',bookId:state.book.id,pageNo,text,revision});return result.revision;}} onAdd={async(text,revision,entryId)=>{await request({action:'text',bookId:state.book.id,pageNo,body:text,revision,entryId});await refresh(state.book.id);}}/>}
        <div className="mt-4 max-h-[650px] space-y-3 overflow-y-auto">{state?.entries.length?state.entries.map(entry=><EntryCard key={entry.id} bookId={state.book.id} entry={entry} disabled={busy||state.book.status==='archiving'} onSave={async(body,revision)=>{const result=await request({action:'edit',bookId:state.book.id,entryId:entry.id,body,revision});return result.revision;}} onDelete={()=>action(async()=>{await request({action:'delete',bookId:state.book.id,entryId:entry.id});await refresh(state.book.id);})}/>):<p className="text-sm text-[#695f50]">还没有记录。</p>}</div>
      </section>
      <section className={`${tabletMode?'absolute inset-x-2 bottom-16 z-10 max-h-[46dvh] overflow-y-auto shadow-xl sm:inset-x-auto sm:right-3 sm:top-20 sm:bottom-auto sm:w-[min(400px,42vw)] sm:max-h-[calc(100dvh-160px)] ':''}rounded-2xl border border-[#bdb29b] bg-[#f9f5ea] p-5 ${tabletMode&&panel!=='history'?'hidden':''}`}><h2 className="font-semibold">PDF 版本与历史画册</h2><p className="mt-1 text-xs text-[#695f50]">内容自动保存到当前画册；只有手动点击“生成 PDF”才会建立 PDF 版本。离开两小时后仍可回来续写。</p><div className="mt-3 space-y-2">{state?.versions.map(v=><a key={v.id} target="_blank" rel="noreferrer" className="block text-sm text-[#315b68] underline" href={`/api/sketchbooks?book=${encodeURIComponent(state.book.id)}&pdf=${encodeURIComponent(v.id)}`}>{new Date(v.created_at).toLocaleString('zh-CN')} · 版本 {v.source_revision}</a>)}</div><h3 className="mt-5 text-sm font-semibold">历史画册</h3><div className="mt-2 space-y-2">{state?.archive.map(book=><button type="button" key={book.id} onClick={()=>void action(async()=>{await refresh(book.id);pageRef.current=1;setPageNo(1);})} className="block text-left text-sm text-[#315b68] underline">{new Date(book.created_at).toLocaleString('zh-CN')} 的画册</button>)}</div>{state?.book.status==='archived'&&<button type="button" onClick={()=>void action(async()=>{pageRef.current=1;setPageNo(1);await refresh();})} className="mt-4 rounded-lg bg-[#253b40] px-3 py-2 text-sm text-white">返回当前画册</button>}</section>
    </aside>
  </div>;
}
type AutosavedProps={storageKey:string;initial:string;revision:number;disabled:boolean;maxLength?:number;placeholder?:string;onSave:(text:string,revision:number)=>Promise<number>;onAdd?:(text:string,revision:number,entryId:string)=>Promise<void>};
function AutoSavedText({storageKey,initial,revision,disabled,maxLength,placeholder,onSave,onAdd}:AutosavedProps){
  const [text,setText]=useState(()=>getBackup<{text:string}>(storageKey)?.text??initial);
  const [status,setStatus]=useState<'saved'|'pending'|'failed'>(()=>getBackup(storageKey)?'pending':'saved');
  const [error,setError]=useState('');
  const current=useRef(text),saved=useRef(initial),version=useRef(revision),timer=useRef<ReturnType<typeof setTimeout>|null>(null),chain=useRef<Promise<void>>(Promise.resolve()),entryId=useRef(getBackup<{entryId:string}>(storageKey)?.entryId||crypto.randomUUID()),saveFunction=useRef(onSave),retry=useRef<()=>Promise<void>>(()=>Promise.resolve());
  useEffect(()=>{saveFunction.current=onSave;},[onSave]);
  const flush=useCallback(()=>{
    if(timer.current)clearTimeout(timer.current);timer.current=null;
    chain.current=chain.current.catch(()=>undefined).then(async()=>{
      while(current.current!==saved.current){
        const value=current.current;
        try{const nextRevision=await saveFunction.current(value,version.current);saved.current=value;version.current=nextRevision;if(current.current===value){clearBackup(storageKey);setStatus('saved');setError('');}else putBackup(storageKey,{text:current.current,revision:nextRevision,entryId:entryId.current});}
        catch(e){const message=e instanceof Error?e.message:'保存失败';setStatus('failed');setError(message);if(!message.includes('其他窗口'))setTimeout(()=>void retry.current().catch(()=>undefined),3000);throw e;}
      }
    });
    return chain.current;
  },[storageKey]);
  useEffect(()=>{retry.current=flush;},[flush]);
  useEffect(()=>{const backup=getBackup<{text:string;revision:number;entryId?:string}>(storageKey);if(backup){current.current=backup.text;setText(backup.text);entryId.current=backup.entryId||entryId.current;if(backup.revision!==revision){version.current=backup.revision;setStatus('failed');setError('其他窗口已有新版本，请复制本机文字并核对');}else{setStatus('pending');const handle=setTimeout(()=>void flush().catch(()=>undefined),300);return()=>clearTimeout(handle);}}},[storageKey,revision,flush]);
  useEffect(()=>{if(current.current===saved.current){saved.current=initial;version.current=revision;current.current=initial;setText(initial);}},[initial,revision]);
  useEffect(()=>{const onHide=()=>{if(current.current!==saved.current)void flush().catch(()=>undefined);};window.addEventListener('pagehide',onHide);return()=>{window.removeEventListener('pagehide',onHide);if(timer.current)clearTimeout(timer.current);onHide();};},[flush]);
  const change=(value:string)=>{current.current=value;setText(value);setStatus('pending');if(!putBackup(storageKey,{text:value,revision:version.current,entryId:entryId.current})){setStatus('failed');setError('本机备份空间不足，请保持页面打开');}if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>void flush().catch(()=>undefined),650);};
  const add=async()=>{try{await flush();if(!current.current.trim())return;await onAdd?.(current.current,version.current,entryId.current);current.current='';saved.current='';entryId.current=crypto.randomUUID();clearBackup(storageKey);setText('');setStatus('saved');}catch(e){setStatus('failed');setError(e instanceof Error?e.message:'添加失败');}};
  return <div className="mt-3"><div className="flex gap-2"><textarea value={text} onChange={e=>change(e.target.value)} disabled={disabled} maxLength={maxLength} placeholder={placeholder} rows={onAdd?2:Math.min(12,Math.max(3,Math.ceil(text.length/45)))} className="min-w-0 flex-1 resize-y rounded-lg border border-[#c8beaa] bg-white p-2 text-sm disabled:opacity-60"/>{onAdd&&<button type="button" disabled={disabled||!text.trim()} onClick={()=>void add()} className="self-start rounded-lg bg-[#d9c99e] px-3 py-2 text-sm disabled:opacity-50">添加</button>}</div><p role="status" className="mt-1 text-xs text-[#736c60]">{status==='saved'?'已保存':status==='pending'?'待保存…':'保存失败'}{status==='failed'&&<><button type="button" onClick={()=>void flush().catch(()=>undefined)} className="ml-2 underline">重试</button><button type="button" onClick={()=>void navigator.clipboard.writeText(current.current)} className="ml-2 underline">复制本机文字</button><button type="button" onClick={()=>{clearBackup(storageKey);window.location.reload();}} className="ml-2 underline">载入服务器版本</button></>}</p>{error&&<p role="alert" className="text-xs text-[#a03e31]">{error}</p>}</div>;
}
function EntryCard({bookId,entry,disabled,onSave,onDelete}:{bookId:string;entry:Entry;disabled:boolean;onSave:(body:string,revision:number)=>Promise<number>;onDelete:()=>Promise<void>}){return <article className="rounded-lg border border-[#d4c9b5] bg-white p-3"><div className="mb-2 flex items-center justify-between text-xs text-[#736c60]"><span>第 {entry.page_no} 页 · {entry.kind==='answer'?'AI 回答':entry.kind==='question'?'问题原文':'补充文字'}</span><button type="button" disabled={disabled} onClick={()=>void onDelete()} aria-label="删除记录" className="text-[#9b4b3d] disabled:opacity-50"><Trash2 className="size-4"/></button></div><AutoSavedText storageKey={`sketch-entry:${bookId}:${entry.id}`} initial={entry.body} revision={entry.edit_revision} disabled={disabled} maxLength={30000} onSave={onSave}/></article>;}
