'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {Document,Page,pdfjs} from 'react-pdf';
import {Excalidraw,convertToExcalidrawElements} from '@excalidraw/excalidraw';
import type {DataURL,ExcalidrawInitialDataState} from '@excalidraw/excalidraw/types';
import type {ExcalidrawElement,FileId} from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';

pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();

type PageImage={dataURL:string;width:number;height:number};
type SceneElements=readonly ExcalidrawElement[];
type ElementSkeleton=NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
type ExcalidrawProps=React.ComponentProps<typeof Excalidraw>;
type SceneChange=NonNullable<ExcalidrawProps['onChange']>;

function readSaved(key:string):SceneElements{
  try{const value:unknown=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value as SceneElements:[];}catch{return [];}
}

export function ExcalidrawPdfPrototype(){
  const [file,setFile]=useState<File|null>(null),[source,setSource]=useState<string|null>(null);
  const [page,setPage]=useState(1),[pageCount,setPageCount]=useState(0),[image,setImage]=useState<PageImage|null>(null);
  const [editing,setEditing]=useState(false),[scene,setScene]=useState<ExcalidrawProps['initialData']>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),lastScene=useRef<SceneElements>([]);
  const pendingKey=useRef(''),backgroundId=useRef('');
  const storageKey=file?`pdf-excalidraw-probe:${file.name}:${file.size}:${file.lastModified}:${page}`:'';

  function flushScene(){
    if(timer.current)clearTimeout(timer.current);
    timer.current=null;
    if(!pendingKey.current)return;
    try{localStorage.setItem(pendingKey.current,JSON.stringify(lastScene.current));}catch{/* Research-only browser storage. */}
    pendingKey.current='';
  }

  useEffect(()=>{
    if(!file)return;
    const url=URL.createObjectURL(file);setSource(url);
    return()=>URL.revokeObjectURL(url);
  },[file]);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);

  const capture=useCallback(()=>{
    const canvas=document.querySelector<HTMLCanvasElement>('.prototype-pdf-page canvas.react-pdf__Page__canvas');
    if(!canvas)return;
    setImage({dataURL:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height});
  },[]);

  function openEditor(){
    if(!image||!storageKey)return;
    const fileId=`pdf-page-${file!.size}-${page}` as FileId;
    const background=convertToExcalidrawElements([{
      type:'image',id:'pdf-background-image',x:0,y:0,width:image.width,height:image.height,
      fileId,status:'saved',locked:true,scale:[1,1],crop:null,
    } as ElementSkeleton])[0];
    backgroundId.current=background.id;
    const saved=readSaved(storageKey).filter(element=>element.id!==background.id);
    lastScene.current=saved;
    setScene({
      elements:[background,...saved],
      files:{[fileId]:{id:fileId,mimeType:'image/png',dataURL:image.dataURL as DataURL,created:Date.now()}},
      appState:{viewBackgroundColor:'#ffffff'},
    } satisfies ExcalidrawInitialDataState);
    setEditing(true);
  }

  const onChange:SceneChange=(elements)=>{
    if(!storageKey)return;
    lastScene.current=elements.filter(element=>element.id!==backgroundId.current&&!element.isDeleted) as SceneElements;
    pendingKey.current=storageKey;
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(flushScene,900);
  };

  function leaveEditor(){
    flushScene();
    setEditing(false);setScene(null);
  }

  async function loadSample(){
    flushScene();
    const {PDFDocument,StandardFonts}=await import('pdf-lib');
    const pdf=await PDFDocument.create(),samplePage=pdf.addPage([612,792]);
    const font=await pdf.embedFont(StandardFonts.Helvetica);
    samplePage.drawText('Selectable PDF text for drawing test',{x:72,y:700,size:18,font});
    const bytes=await pdf.save();
    setEditing(false);setScene(null);setImage(null);setPage(1);setPageCount(0);
    setFile(new File([new Uint8Array(bytes)],'excalidraw-prototype-sample.pdf',{type:'application/pdf',lastModified:0}));
  }

  return <main className="mx-auto max-w-6xl space-y-4 p-4">
    <h1 className="text-xl font-semibold">PDF + Excalidraw 研究原型</h1>
    <p className="text-sm text-muted-foreground">本地上传一份 PDF；绘图只存在当前浏览器，不会上传或同步到资料库。</p>
    <div className="flex flex-wrap items-center gap-3">
      <input type="file" accept="application/pdf,.pdf" onChange={event=>{
        flushScene();
        setEditing(false);setScene(null);setImage(null);setPage(1);setPageCount(0);
        setFile(event.target.files?.[0]||null);
      }}/>
      <button type="button" className="rounded border px-3 py-2" onClick={()=>void loadSample()}>加载测试 PDF</button>
      {file&&<label>页码 <input type="number" min={1} max={pageCount||1} value={page} onChange={event=>{flushScene();setEditing(false);setImage(null);setPage(Math.min(pageCount||1,Math.max(1,Number(event.target.value)||1)));}} className="w-16 rounded border p-1"/> / {pageCount||'…'}</label>}
      {!editing&&image&&<button type="button" className="rounded bg-black px-3 py-2 text-white" onClick={openEditor}>在 Excalidraw 中绘图</button>}
      {editing&&<button type="button" className="rounded border px-3 py-2" onClick={leaveEditor}>返回 PDF 阅读</button>}
    </div>
    {source&&<div className={editing?'hidden':'prototype-pdf-page w-fit max-w-full overflow-auto border shadow'}>
      <Document file={source} onLoadSuccess={({numPages})=>setPageCount(numPages)}>
        <Page pageNumber={page} width={900} onRenderSuccess={()=>requestAnimationFrame(capture)} renderTextLayer renderAnnotationLayer/>
      </Document>
    </div>}
    {editing&&scene&&<div className="h-[75vh] min-h-[550px] overflow-hidden rounded border"><Excalidraw key={storageKey} initialData={scene} onChange={onChange} langCode="zh-CN" handleKeyboardGlobally={false}/></div>}
  </main>;
}
