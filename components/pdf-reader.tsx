'use client';

import {useCallback,useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {Brush,ChevronLeft,ChevronRight,Eraser,MousePointer2,Redo2,RotateCw,Save,Trash2,Undo2,ZoomIn,ZoomOut} from 'lucide-react';
import {Document,Page,pdfjs} from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {Button} from './ui/button';
import type {AnnotationPoint,AnnotationStroke} from '@/lib/pdf-annotations';

pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();

type Tool='view'|'pen'|'eraser';
type Status='saved'|'unsaved'|'saving'|'error'|'conflict'|'load-error';
type PageInk={strokes:AnnotationStroke[];undo:AnnotationStroke[][];redo:AnnotationStroke[][];revision:number;version:number;dirty:boolean;status:Status};
type ActiveStroke={page:number;pointerId:number;before:AnnotationStroke[];changed:boolean};

const copyStrokes=(strokes:AnnotationStroke[])=>strokes.map(stroke=>({...stroke,points:[...stroke.points]}));
const blank=(revision=0,strokes:AnnotationStroke[]=[]):PageInk=>({strokes,undo:[],redo:[],revision,version:0,dirty:false,status:'saved'});
const clamp=(value:number)=>Math.min(1,Math.max(0,value));
function validDraft(value:unknown):value is {revision:number;strokes:AnnotationStroke[]}{
  if(!value||typeof value!=='object')return false;
  const draft=value as {revision?:unknown;strokes?:unknown};
  return Number.isSafeInteger(draft.revision)&&Array.isArray(draft.strokes)&&draft.strokes.length<=1000&&draft.strokes.every(stroke=>stroke&&typeof stroke.id==='string'&&/^#[0-9a-fA-F]{6}$/.test(stroke.color)&&typeof stroke.width==='number'&&stroke.width>=0.001&&stroke.width<=0.03&&Array.isArray(stroke.points)&&stroke.points.length>0&&stroke.points.length<=3000&&stroke.points.every((point:AnnotationPoint)=>Number.isFinite(point?.x)&&Number.isFinite(point?.y)&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1));
}

function visualPoint(point:AnnotationPoint,rotation:number):AnnotationPoint{
  if(rotation===90)return {x:1-point.y,y:point.x};
  if(rotation===180)return {x:1-point.x,y:1-point.y};
  if(rotation===270)return {x:point.y,y:1-point.x};
  return point;
}
function canonicalPoint(point:AnnotationPoint,rotation:number):AnnotationPoint{
  if(rotation===90)return {x:point.y,y:1-point.x};
  if(rotation===180)return {x:1-point.x,y:1-point.y};
  if(rotation===270)return {x:1-point.y,y:point.x};
  return point;
}
function distanceToSegment(x:number,y:number,ax:number,ay:number,bx:number,by:number){
  const dx=bx-ax,dy=by-ay,t=dx*dx+dy*dy?Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy))):0;
  return Math.hypot(x-(ax+t*dx),y-(ay+t*dy));
}

export function PdfReader({source,name,documentId}:{source:string;name:string;documentId:string}){
  const container=useRef<HTMLDivElement>(null),pageWrap=useRef<HTMLDivElement>(null);
  const entries=useRef<Record<number,PageInk>>({}),saveTimers=useRef<Record<number,ReturnType<typeof setTimeout>>>({}),saving=useRef(new Set<number>()),active=useRef<ActiveStroke|null>(null);
  const [,render]=useState(0),[pages,setPages]=useState(0),[page,setPage]=useState(1),[zoom,setZoom]=useState(1),[rotation,setRotation]=useState(0),[width,setWidth]=useState(900);
  const [tool,setTool]=useState<Tool>('view'),[color,setColor]=useState('#e63946'),[thickness,setThickness]=useState(4),[overlaySize,setOverlaySize]=useState({width:0,height:0}),[loadNonce,setLoadNonce]=useState(0),[notice,setNotice]=useState('');
  const redraw=()=>render(value=>value+1);
  const url=useCallback((p:number)=>`/api/library/${encodeURIComponent(documentId)}/annotations?page=${p}`,[documentId]);
  const draftKey=useCallback((p:number)=>`pdf-ink:${documentId}:${p}`,[documentId]);
  const writeDraft=useCallback((p:number,entry:PageInk)=>{
    try{if(entry.dirty)localStorage.setItem(draftKey(p),JSON.stringify({revision:entry.revision,strokes:entry.strokes}));else localStorage.removeItem(draftKey(p));}catch{/* Storage may be disabled; server saving still works. */}
  },[draftKey]);

  const savePage=useCallback(async(p:number,keepalive=false)=>{
    if(saving.current.has(p))return;
    saving.current.add(p);
    try{
      while(entries.current[p]?.dirty&&entries.current[p].status!=='conflict'){
        const current=entries.current[p],version=current.version,body=JSON.stringify({revision:current.revision,strokes:current.strokes});
        entries.current[p]={...current,status:'saving'};redraw();
        try{
          const response=await fetch(url(p),{method:'PUT',headers:{'Content-Type':'application/json'},body,keepalive:keepalive&&body.length<60000});
          if(response.status===409){entries.current[p]={...entries.current[p],status:'conflict'};redraw();return;}
          if(!response.ok)throw new Error('保存失败');
          const result=await response.json() as {revision:number};
          const latest=entries.current[p],stillDirty=latest.version!==version;
          entries.current[p]={...latest,revision:result.revision,dirty:stillDirty,status:stillDirty?'unsaved':'saved'};
          writeDraft(p,entries.current[p]);redraw();
        }catch{
          entries.current[p]={...entries.current[p],status:'error'};redraw();
          clearTimeout(saveTimers.current[p]);
          saveTimers.current[p]=setTimeout(()=>void savePage(p),3000);
          return;
        }
      }
    }finally{saving.current.delete(p);}
  },[url,writeDraft]);
  const scheduleSave=useCallback((p:number,delay=900)=>{
    clearTimeout(saveTimers.current[p]);saveTimers.current[p]=setTimeout(()=>void savePage(p),delay);
  },[savePage]);
  const commit=useCallback((p:number,before:AnnotationStroke[])=>{
    const current=entries.current[p];if(!current)return;
    const points=current.strokes.reduce((total,stroke)=>total+stroke.points.length,0);
    if(points>30000||new TextEncoder().encode(JSON.stringify(current.strokes)).length>512*1024){
      entries.current[p]={...current,strokes:before};setNotice('此页批注达到容量上限；刚才的笔画未加入，请先擦除一些内容。');redraw();return;
    }
    entries.current[p]={...current,undo:[...current.undo.slice(-49),before],redo:[],version:current.version+1,dirty:true,status:'unsaved'};
    writeDraft(p,entries.current[p]);redraw();scheduleSave(p);
  },[scheduleSave,writeDraft]);

  useEffect(()=>{
    const element=container.current;if(!element)return;
    const resize=()=>setWidth(Math.max(280,Math.min(1100,element.clientWidth-32)));
    resize();const observer=new ResizeObserver(resize);observer.observe(element);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const element=pageWrap.current;if(!element)return;
    const resize=()=>setOverlaySize({width:element.clientWidth,height:element.clientHeight});
    resize();const observer=new ResizeObserver(resize);observer.observe(element);return()=>observer.disconnect();
  },[page,zoom,rotation,pages]);
  useEffect(()=>{
    if(entries.current[page])return;
    let cancelled=false;
    fetch(url(page),{cache:'no-store'}).then(async response=>{
      if(!response.ok)throw new Error('加载失败');return response.json() as Promise<{revision:number;strokes:AnnotationStroke[]}>;
    }).then(result=>{
      if(cancelled)return;
      let entry=blank(result.revision,result.strokes);
      try{
        const draft:unknown=JSON.parse(localStorage.getItem(draftKey(page))||'null');
        if(validDraft(draft))entry={...entry,strokes:draft.strokes,dirty:true,status:draft.revision===result.revision?'unsaved':'conflict'};
      }catch{/* Ignore invalid browser storage. */}
      entries.current[page]=entry;redraw();
      if(entry.dirty&&entry.status!=='conflict')scheduleSave(page,200);
    }).catch(()=>{if(!cancelled){entries.current[page]={...blank(),status:'load-error'};redraw();}});
    return()=>{cancelled=true;};
  },[page,url,draftKey,scheduleSave,loadNonce]);
  useEffect(()=>{
    const flush=()=>{
      const gesture=active.current;
      if(gesture){active.current=null;if(gesture.changed)commit(gesture.page,gesture.before);}
      for(const key of Object.keys(entries.current)){const p=Number(key);clearTimeout(saveTimers.current[p]);if(entries.current[p].dirty)void savePage(p,true);}
    };
    const onVisibility=()=>{if(document.visibilityState==='hidden')flush();};
    document.addEventListener('visibilitychange',onVisibility);window.addEventListener('pagehide',flush);
    return()=>{document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',flush);flush();};
  },[savePage,commit]);

  function go(next:number){if(active.current)finishPointer();setPage(Math.min(Math.max(1,next),pages||1));}
  function mappedPointer(event:ReactPointerEvent<SVGSVGElement>):AnnotationPoint{
    const rect=event.currentTarget.getBoundingClientRect();
    return canonicalPoint({x:clamp((event.clientX-rect.left)/rect.width),y:clamp((event.clientY-rect.top)/rect.height)},rotation);
  }
  function eraseAt(p:number,point:AnnotationPoint){
    const current=entries.current[p];if(!current)return;
    const test=visualPoint(point,rotation),x=test.x*overlaySize.width,y=test.y*overlaySize.height;
    const index=current.strokes.findLastIndex(stroke=>{
      const points=stroke.points.map(item=>{const v=visualPoint(item,rotation);return {x:v.x*overlaySize.width,y:v.y*overlaySize.height};});
      const radius=Math.max(10,stroke.width*(rotation%180?overlaySize.height:overlaySize.width)/2+7);
      return points.some((item,i)=>distanceToSegment(x,y,item.x,item.y,points[Math.min(i+1,points.length-1)].x,points[Math.min(i+1,points.length-1)].y)<radius);
    });
    if(index>=0){entries.current[p]={...current,strokes:current.strokes.filter((_,i)=>i!==index)};if(active.current)active.current.changed=true;redraw();}
  }
  function pointerDown(event:ReactPointerEvent<SVGSVGElement>){
    if(tool==='view'||!entries.current[page]||entries.current[page].status==='load-error'||entries.current[page].status==='conflict'||active.current||event.pointerType==='mouse'&&event.button!==0)return;
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setNotice('');
    const current=entries.current[page],point=mappedPointer(event);
    active.current={page,pointerId:event.pointerId,before:copyStrokes(current.strokes),changed:false};
    if(tool==='pen'){
      if(current.strokes.length>=1000||current.strokes.reduce((total,stroke)=>total+stroke.points.length,0)>=30000){active.current=null;setNotice('此页批注达到容量上限，请先擦除一些内容。');return;}
      entries.current[page]={...current,strokes:[...current.strokes,{id:crypto.randomUUID(),color,width:thickness/1000,points:[point]}]};
      active.current.changed=true;redraw();
    }else eraseAt(page,point);
  }
  function pointerMove(event:ReactPointerEvent<SVGSVGElement>){
    const gesture=active.current;if(!gesture||gesture.pointerId!==event.pointerId)return;
    event.preventDefault();const point=mappedPointer(event);
    if(tool==='eraser'){eraseAt(gesture.page,point);return;}
    const current=entries.current[gesture.page],strokes=current.strokes,last=strokes[strokes.length-1],previous=last?.points[last.points.length-1];
    if(!last||!previous)return;
    if(last.points.length>=3000){setNotice('单笔已达到长度上限，余下路径未绘制。');return;}
    if(Math.hypot(point.x-previous.x,point.y-previous.y)<0.0007)return;
    entries.current[gesture.page]={...current,strokes:[...strokes.slice(0,-1),{...last,points:[...last.points,point]}]};redraw();
  }
  function finishPointer(){const gesture=active.current;if(!gesture)return;active.current=null;if(gesture.changed)commit(gesture.page,gesture.before);}
  function undoRedo(direction:'undo'|'redo'){
    const current=entries.current[page];if(!current||current.status==='conflict')return;
    const from=direction==='undo'?current.undo:current.redo,to=direction==='undo'?current.redo:current.undo;
    if(!from.length)return;
    const previous=from[from.length-1];
    entries.current[page]={...current,strokes:copyStrokes(previous),[direction]:from.slice(0,-1),[direction==='undo'?'redo':'undo']:[...to.slice(-49),copyStrokes(current.strokes)],version:current.version+1,dirty:true,status:'unsaved'};
    writeDraft(page,entries.current[page]);redraw();scheduleSave(page);
  }
  function discardConflict(){
    try{localStorage.removeItem(draftKey(page));}catch{/* Continue with server reload. */}
    delete entries.current[page];setNotice('已放弃本地草稿，正在读取服务器版本。');setLoadNonce(value=>value+1);
  }
  async function overwriteConflict(){
    const current=entries.current[page];if(!current)return;
    try{
      const response=await fetch(url(page),{cache:'no-store'});if(!response.ok)throw new Error('加载失败');
      const result=await response.json() as {revision:number};
      const latest=entries.current[page];if(latest!==current)return;
      entries.current[page]={...latest,revision:result.revision,status:'unsaved',dirty:true};
      writeDraft(page,entries.current[page]);setNotice('正在以本地草稿覆盖服务器版本。');redraw();scheduleSave(page,0);
    }catch{setNotice('无法读取服务器版本，请检查网络后重试。');}
  }
  const ink=entries.current[page],canEdit=Boolean(ink&&ink.status!=='load-error'&&ink.status!=='conflict');
  const statusText:Record<Status,string>={saved:'已保存',unsaved:'待保存',saving:'正在保存…',error:'保存失败，正在重试',conflict:'其它窗口已更新；请选择如何处理本地草稿','load-error':'批注加载失败'};
  const naturalWidth=rotation%180?overlaySize.height:overlaySize.width;

  return <section className="overflow-hidden rounded-2xl border bg-neutral-200/70 shadow-sm dark:bg-neutral-950/60">
    <div className="sticky top-0 z-20 border-b bg-background/95 px-3 py-2 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="ghost" disabled={page<=1} onClick={()=>go(page-1)} aria-label="上一页"><ChevronLeft className="size-4"/></Button>
          <label className="flex items-center gap-2 text-sm"><input aria-label="当前页码" inputMode="numeric" className="h-8 w-14 rounded-md border bg-background px-2 text-center" value={page} onChange={event=>go(Number(event.target.value)||1)}/><span className="whitespace-nowrap text-muted-foreground">/ {pages||'—'} 页</span></label>
          <Button type="button" size="icon" variant="ghost" disabled={!pages||page>=pages} onClick={()=>go(page+1)} aria-label="下一页"><ChevronRight className="size-4"/></Button>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="ghost" disabled={zoom<=0.6} onClick={()=>setZoom(value=>Math.max(0.6,Number((value-0.15).toFixed(2))))} aria-label="缩小"><ZoomOut className="size-4"/></Button>
          <button type="button" className="min-w-16 rounded-md px-2 py-1 text-sm hover:bg-muted" onClick={()=>setZoom(1)} aria-label="恢复原始缩放">{Math.round(zoom*100)}%</button>
          <Button type="button" size="icon" variant="ghost" disabled={zoom>=2} onClick={()=>setZoom(value=>Math.min(2,Number((value+0.15).toFixed(2))))} aria-label="放大"><ZoomIn className="size-4"/></Button>
          <Button type="button" size="icon" variant="ghost" onClick={()=>setRotation(value=>(value+90)%360)} aria-label="顺时针旋转"><RotateCw className="size-4"/></Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 border-t pt-2">
        <Button type="button" size="sm" variant={tool==='view'?'default':'ghost'} onClick={()=>setTool('view')} aria-label="阅读和选中文字"><MousePointer2 className="mr-1 size-4"/>阅读</Button>
        <Button type="button" size="sm" variant={tool==='pen'?'default':'ghost'} disabled={!canEdit} onClick={()=>setTool('pen')} aria-label="画笔"><Brush className="mr-1 size-4"/>画笔</Button>
        <Button type="button" size="sm" variant={tool==='eraser'?'default':'ghost'} disabled={!canEdit} onClick={()=>setTool('eraser')} aria-label="橡皮擦"><Eraser className="mr-1 size-4"/>橡皮擦</Button>
        <label className="ml-2 flex items-center gap-1 text-xs">颜色 <input type="color" aria-label="画笔颜色" value={color} onChange={event=>setColor(event.target.value)} className="h-7 w-8 cursor-pointer"/></label>
        <label className="flex items-center gap-1 text-xs">粗细 <input type="range" aria-label="画笔粗细" min="2" max="16" value={thickness} onChange={event=>setThickness(Number(event.target.value))} className="w-20"/><span>{thickness}</span></label>
        <Button type="button" size="icon" variant="ghost" disabled={!canEdit||!ink?.undo.length} onClick={()=>undoRedo('undo')} aria-label="撤销"><Undo2 className="size-4"/></Button>
        <Button type="button" size="icon" variant="ghost" disabled={!canEdit||!ink?.redo.length} onClick={()=>undoRedo('redo')} aria-label="重做"><Redo2 className="size-4"/></Button>
        <Button type="button" size="icon" variant="ghost" disabled={!canEdit||!ink?.strokes.length} onClick={()=>{if(ink){const before=copyStrokes(ink.strokes);entries.current[page]={...ink,strokes:[]};commit(page,before);}}} aria-label="清空当前页批注"><Trash2 className="size-4"/></Button>
        <span role="status" className="ml-auto text-xs text-muted-foreground">{ink?statusText[ink.status]:'正在加载批注…'}</span>
        {ink?.dirty&&ink.status!=='conflict'&&<Button type="button" size="sm" variant="outline" onClick={()=>void savePage(page)}><Save className="mr-1 size-4"/>立即保存</Button>}
        {ink?.status==='conflict'&&<><Button type="button" size="sm" variant="outline" onClick={()=>void overwriteConflict()}>保留本地并覆盖</Button><Button type="button" size="sm" variant="outline" onClick={discardConflict}>放弃本地并重载</Button></>}
        {ink?.status==='load-error'&&<Button type="button" size="sm" variant="outline" onClick={()=>{delete entries.current[page];setLoadNonce(value=>value+1);}}>重试加载</Button>}
      </div>
      {notice&&<p role="alert" className="pt-1 text-xs text-amber-700 dark:text-amber-300">{notice}</p>}
    </div>
    <div ref={container} className="max-h-[78vh] min-h-[60vh] overflow-auto p-4">
      <Document file={source} onLoadSuccess={({numPages})=>{setPages(numPages);setPage(current=>Math.min(current,numPages));}} loading={<p className="py-24 text-center text-muted-foreground">正在加载 PDF…</p>} error={<div className="mx-auto max-w-lg rounded-xl border bg-background p-6 text-center"><strong>PDF 暂时无法显示</strong><p className="mt-2 text-sm text-muted-foreground">请刷新页面重试，或使用上方的“下载原件”。</p></div>}>
        <div ref={pageWrap} className="relative mx-auto w-fit shadow-xl">
          <Page pageNumber={page} width={width*zoom} rotate={rotation} renderAnnotationLayer renderTextLayer loading={<p className="py-24 text-center text-muted-foreground">正在绘制第 {page} 页…</p>}/>
          {overlaySize.width>0&&overlaySize.height>0&&<svg className="absolute inset-0 z-10" width={overlaySize.width} height={overlaySize.height} viewBox={`0 0 ${overlaySize.width} ${overlaySize.height}`} style={{pointerEvents:tool==='view'||!canEdit?'none':'auto',touchAction:tool==='view'?'auto':'none',cursor:tool==='eraser'?'crosshair':tool==='pen'?'crosshair':'auto'}} aria-label="PDF 批注画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={finishPointer} onPointerCancel={finishPointer}>
            {ink?.strokes.map(stroke=>{
              const points=stroke.points.map(point=>{const visual=visualPoint(point,rotation);return {x:visual.x*overlaySize.width,y:visual.y*overlaySize.height};});
              const strokeWidth=stroke.width*naturalWidth;
              return points.length===1?<circle key={stroke.id} cx={points[0].x} cy={points[0].y} r={strokeWidth/2} fill={stroke.color}/>:<path key={stroke.id} d={points.map((point,i)=>`${i?'L':'M'}${point.x} ${point.y}`).join(' ')} fill="none" stroke={stroke.color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>;
            })}
          </svg>}
        </div>
      </Document>
    </div>
    <p className="border-t bg-background/80 px-4 py-2 text-center text-xs text-muted-foreground">{name} · 阅读模式可选中文字；批注自动保存，下载原件不会包含批注</p>
  </section>;
}
