'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {CaptureUpdateAction,Excalidraw,convertToExcalidrawElements} from '@excalidraw/excalidraw';
import type {DataURL,ExcalidrawImperativeAPI,ExcalidrawInitialDataState,NormalizedZoomValue} from '@excalidraw/excalidraw/types';
import type {ExcalidrawElement,FileId} from '@excalidraw/excalidraw/element/types';
import type {AnnotationScene} from '@/lib/pdf-annotation-scenes';
import '@excalidraw/excalidraw/index.css';

type EditorProps=React.ComponentProps<typeof Excalidraw>;
type Draft={revision:number;scene:AnnotationScene};
type Status='saved'|'unsaved'|'saving'|'error'|'conflict';
const ALLOWED_TYPES=new Set(['rectangle','diamond','ellipse','arrow','line','freedraw','text']);

function insidePage(element:ExcalidrawElement,pageWidth:number,pageHeight:number){
  const {x,y,width,height,angle}=element;
  if(![x,y,width,height,angle].every(Number.isFinite)||width<0||height<0)return false;
  const centerX=x+width/2,centerY=y+height/2,cos=Math.cos(angle),sin=Math.sin(angle);
  return [[x,y],[x+width,y],[x+width,y+height],[x,y+height]].every(([px,py])=>{
    const rx=centerX+(px-centerX)*cos-(py-centerY)*sin;
    const ry=centerY+(px-centerX)*sin+(py-centerY)*cos;
    return rx>=-0.001&&ry>=-0.001&&rx<=pageWidth+0.001&&ry<=pageHeight+0.001;
  });
}

function getDraft(key:string):Draft|null{
  try{
    const draft=JSON.parse(localStorage.getItem(key)||'null') as Draft|null;
    if(draft&&Number.isSafeInteger(draft.revision)&&Array.isArray(draft.scene?.elements))return draft;
  }catch{/* Ignore a damaged browser draft. */}
  return null;
}

export function PdfExcalidrawEditor({documentId,page,background,scene,revision,onSceneChange,onClose}:{documentId:string;page:number;background:{dataURL:string;width:number;height:number};scene:AnnotationScene;revision:number;onSceneChange:(scene:AnnotationScene,revision:number)=>void;onClose:()=>void}){
  const key=`pdf-excalidraw:${documentId}:${page}`;
  const initial=useMemo(()=>getDraft(key),[key]);
  const [starting]=useState(()=>initial?.scene||scene);
  const elements=useRef<ExcalidrawElement[]>(starting.elements as ExcalidrawElement[]),lastJson=useRef(JSON.stringify(starting.elements));
  const currentRevision=useRef(revision),version=useRef(0),dirty=useRef(Boolean(initial));
  const saving=useRef(false),editorApi=useRef<ExcalidrawImperativeAPI|null>(null),rollbackTimer=useRef<ReturnType<typeof setTimeout>|null>(null),rollbackPending=useRef(false),pointerIsDown=useRef(false);
  const saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),dirtySince=useRef(0);
  const [status,setStatus]=useState<Status>(initial&&initial.revision!==revision?'conflict':initial?'unsaved':'saved');
  const statusRef=useRef<Status>(status);
  const updateStatus=useCallback((value:Status)=>{statusRef.current=value;setStatus(value);},[]);
  const [message,setMessage]=useState('');
  const sceneUrl=`/api/library/${encodeURIComponent(documentId)}/annotation-scenes?page=${page}`;

  const imageFileId=`pdf-page-${documentId}-${page}` as FileId;
  const [prepared]=useState(()=>{
    const image=convertToExcalidrawElements([{
      type:'image',id:'pdf-background-image',x:0,y:0,width:background.width,height:background.height,
      fileId:imageFileId,status:'saved',locked:true,scale:[1,1],crop:null,
    } as NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number]])[0];
    const border=convertToExcalidrawElements([{
      type:'rectangle',id:'pdf-page-boundary',x:0,y:0,width:background.width,height:background.height,
      strokeColor:'#2563eb',strokeWidth:2,roughness:0,backgroundColor:'transparent',locked:true,
    }])[0];
    const initialData={
      elements:[image,border,...starting.elements as ExcalidrawElement[]],
      files:{[imageFileId]:{id:imageFileId,mimeType:'image/png',dataURL:background.dataURL as DataURL,created:0}},
      appState:{viewBackgroundColor:'#f1f5f9',zoom:{value:0.8 as NormalizedZoomValue}},
    } satisfies ExcalidrawInitialDataState;
    return {initialData,backgroundId:image.id,borderId:border.id};
  });

  const writeDraft=useCallback(()=>{
    if(draftTimer.current)clearTimeout(draftTimer.current);
    draftTimer.current=null;
    try{
      if(dirty.current)localStorage.setItem(key,JSON.stringify({revision:currentRevision.current,scene:{elements:elements.current,pageWidth:background.width,pageHeight:background.height}}));
      else localStorage.removeItem(key);
    }catch{setMessage('浏览器草稿空间不足；请及时检查服务器保存状态。');}
  },[key,background.width,background.height]);

  const save=useCallback(async(keepalive=false)=>{
    if(saving.current||!dirty.current||statusRef.current==='conflict')return;
    saving.current=true;
    try{
      while(dirty.current){
        const atVersion=version.current;
        const currentScene={elements:elements.current,pageWidth:background.width,pageHeight:background.height};
        const body=JSON.stringify({revision:currentRevision.current,scene:currentScene});
        if(new TextEncoder().encode(body).length>1024*1024){updateStatus('error');setMessage('此页绘图超过 1 MB 上限，请删除一些元素。');return;}
        updateStatus('saving');
        try{
          const response=await fetch(sceneUrl,{method:'PUT',headers:{'Content-Type':'application/json'},body,keepalive:keepalive&&body.length<60000});
          if(response.status===409){updateStatus('conflict');setMessage('其它窗口修改了这页，请选择保留本地或重载服务器版本。');return;}
          if(!response.ok)throw new Error('保存失败');
          const result=await response.json() as {revision:number};
          currentRevision.current=result.revision;
          dirty.current=version.current!==atVersion;
          onSceneChange(currentScene,result.revision);
          writeDraft();
          updateStatus(dirty.current?'unsaved':'saved');
          setMessage('');
        }catch{
          updateStatus('error');setMessage('保存失败，保留了浏览器草稿，稍后自动重试。');
          if(saveTimer.current)clearTimeout(saveTimer.current);
          saveTimer.current=setTimeout(()=>void save(),3000);
          return;
        }
      }
    }finally{saving.current=false;}
  },[background.width,background.height,onSceneChange,sceneUrl,updateStatus,writeDraft]);

  const scheduleSave=useCallback(()=>{
    if(saveTimer.current)clearTimeout(saveTimer.current);
    if(!dirtySince.current)dirtySince.current=Date.now();
    const delay=Math.min(900,Math.max(0,5000-(Date.now()-dirtySince.current)));
    saveTimer.current=setTimeout(()=>{dirtySince.current=0;void save();},delay);
  },[save]);

  const saveRef=useRef(save);
  useEffect(()=>{saveRef.current=save;},[save]);
  useEffect(()=>{
    if(!initial||initial.revision!==revision)return;
    const timer=setTimeout(()=>void saveRef.current(),200);
    return()=>clearTimeout(timer);
  },[initial,revision]);
  useEffect(()=>{
    const flush=()=>{writeDraft();if(dirty.current)void saveRef.current(true);};
    window.addEventListener('pagehide',flush);
    return()=>{
      window.removeEventListener('pagehide',flush);
      if(saveTimer.current)clearTimeout(saveTimer.current);
      if(draftTimer.current)clearTimeout(draftTimer.current);
      if(rollbackTimer.current)clearTimeout(rollbackTimer.current);
      flush();
    };
  },[writeDraft]);

  const restoreAcceptedNow=()=>{
    if(rollbackTimer.current)clearTimeout(rollbackTimer.current);
    rollbackTimer.current=null;
    const api=editorApi.current;
    if(!api){if(rollbackPending.current){updateStatus('error');setMessage('无法恢复越界图形，请返回阅读模式后重试。');}return;}
    const appState=api.getAppState();
    const visible=[...api.getSceneElements(),appState.newElement,appState.resizingElement,appState.multiElement];
    const outside=visible.some(element=>element&&element.id!==prepared.backgroundId&&element.id!==prepared.borderId&&!element.isDeleted&&!insidePage(element,background.width,background.height));
    // A rejected shape can remain visible as Excalidraw's in-progress
    // newElement even when the committed scene is already back inside.
    if(!outside&&!rollbackPending.current)return;
    rollbackPending.current=false;
    api.updateScene({
      elements:[...prepared.initialData.elements!.slice(0,2),...elements.current],
      appState:{selectedElementIds:{},editingTextElement:null,newElement:null,resizingElement:null,multiElement:null,selectionElement:null},
      captureUpdate:CaptureUpdateAction.NEVER,
    });
    updateStatus(dirty.current?'unsaved':'saved');
    setMessage('已把越界图形恢复到 PDF 页内。');
    api.setToast({message:'已把越界图形恢复到 PDF 页内。',duration:3000});
  };
  const restoreAccepted=()=>{
    if(rollbackTimer.current)clearTimeout(rollbackTimer.current);
    // Let Excalidraw publish its final transform before reading its scene.
    rollbackTimer.current=setTimeout(()=>{
      rollbackTimer.current=null;
      if(!pointerIsDown.current)restoreAcceptedNow();
    },100);
  };
  const beginPointer=()=>{
    // Resolve the previous gesture before Excalidraw starts a new one. Its
    // delayed rollback must never discard a legitimate subsequent stroke.
    if(rollbackTimer.current||rollbackPending.current)restoreAcceptedNow();
    pointerIsDown.current=true;
  };
  const restoreRef=useRef(restoreAccepted);
  useEffect(()=>{restoreRef.current=restoreAccepted;});
  useEffect(()=>{
    const release=()=>{pointerIsDown.current=false;restoreRef.current();};
    window.addEventListener('pointerup',release,true);
    window.addEventListener('pointercancel',release,true);
    window.addEventListener('mouseup',release,true);
    return()=>{window.removeEventListener('pointerup',release,true);window.removeEventListener('pointercancel',release,true);window.removeEventListener('mouseup',release,true);};
  },[]);

  const onChange:NonNullable<EditorProps['onChange']>=(all)=>{
    if(statusRef.current==='conflict')return;
    const next=all.filter(element=>element.id!==prepared.backgroundId&&element.id!==prepared.borderId&&!element.isDeleted);
    if(next.some(element=>!ALLOWED_TYPES.has(element.type)||element.link)){
      updateStatus('error');setMessage('此模式暂不保存图片、网页嵌入或外链；请删除这些元素。');
      return;
    }
    if(next.some(element=>!insidePage(element,background.width,background.height))){
      // Excalidraw's canvas is infinite; wait for pointer-up before rolling back a
      // drag, so its internal transform cannot race a programmatic scene update.
      rollbackPending.current=true;
      if(!pointerIsDown.current)restoreAccepted();
      updateStatus(dirty.current?'unsaved':'saved');
      setMessage('图形超出 PDF 页边界，松开后会恢复到页内。');
      return;
    }
    rollbackPending.current=false;
    const json=JSON.stringify(next);
    if(json===lastJson.current)return;
    lastJson.current=json;elements.current=JSON.parse(json) as ExcalidrawElement[];version.current++;dirty.current=true;
    updateStatus('unsaved');setMessage('');
    if(!draftTimer.current)draftTimer.current=setTimeout(writeDraft,500);
    scheduleSave();
  };

  function close(){writeDraft();if(statusRef.current!=='conflict')onSceneChange({elements:elements.current,pageWidth:background.width,pageHeight:background.height},currentRevision.current);void save(true);onClose();}
  async function overwrite(){
    try{
      const response=await fetch(sceneUrl,{cache:'no-store'});if(!response.ok)throw new Error('加载失败');
      const latest=await response.json() as {revision:number};
      currentRevision.current=latest.revision;dirty.current=true;updateStatus('unsaved');setMessage('正在使用本地版本覆盖服务器。');void save();
    }catch{setMessage('暂时无法读取服务器版本，请检查网络。');}
  }
  function discard(){try{localStorage.removeItem(key);}catch{/* Continue reload. */}window.location.reload();}

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
      <button type="button" className="rounded border px-2 py-1" onClick={close}>返回 PDF 阅读</button>
      <span>扩展绘图 · 第 {page} 页</span>
      <span role="status" className="ml-auto text-muted-foreground">{status==='saved'?'已保存':status==='unsaved'?'待保存':status==='saving'?'正在保存…':status==='conflict'?'保存冲突':'保存失败'}</span>
      <button type="button" className="rounded border px-2 py-1" disabled={status==='saved'||status==='saving'||status==='conflict'} onClick={()=>void save()}>立即保存</button>
      {status==='conflict'&&<><button type="button" className="rounded border px-2 py-1" onClick={()=>void overwrite()}>保留本地并覆盖</button><button type="button" className="rounded border px-2 py-1" onClick={discard}>放弃本地并重载</button></>}
    </div>
    {message&&<p role="alert" className="text-sm text-amber-700">{message}</p>}
    <div className="h-[72vh] min-h-[550px] overflow-hidden rounded-lg border bg-white" onPointerDownCapture={beginPointer} onMouseDownCapture={beginPointer}><Excalidraw initialData={prepared.initialData} excalidrawAPI={api=>{editorApi.current=api;}} onChange={onChange} onPointerUp={()=>{pointerIsDown.current=false;restoreAccepted();}} langCode="zh-CN" handleKeyboardGlobally={false} UIOptions={{tools:{image:false},canvasActions:{loadScene:false,saveToActiveFile:false,clearCanvas:false}}} onPaste={()=>false}/></div>
    <p className="text-xs text-muted-foreground">请在蓝色 PDF 页框内绘图。PDF 原页和旧批注仅作为绘图背景；返回阅读后可继续选择 PDF 文字和使用原有橡皮擦。</p>
  </div>;
}
