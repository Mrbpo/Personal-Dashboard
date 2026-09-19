'use client';

import {useEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,RotateCw,ZoomIn,ZoomOut} from 'lucide-react';
import {Document,Page,pdfjs} from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {Button} from './ui/button';

pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();

export function PdfReader({source,name}:{source:string;name:string}){
  const container=useRef<HTMLDivElement>(null);
  const [pages,setPages]=useState(0),[page,setPage]=useState(1),[zoom,setZoom]=useState(1),[rotation,setRotation]=useState(0),[width,setWidth]=useState(900);

  useEffect(()=>{
    const element=container.current;
    if(!element)return;
    const resize=()=>setWidth(Math.max(280,Math.min(1100,element.clientWidth-32)));
    resize();
    const observer=new ResizeObserver(resize);
    observer.observe(element);
    return()=>observer.disconnect();
  },[]);

  function go(next:number){setPage(Math.min(Math.max(1,next),pages||1));}

  return <section className="overflow-hidden rounded-2xl border bg-neutral-200/70 shadow-sm dark:bg-neutral-950/60">
    <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-1">
        <Button type="button" size="icon" variant="ghost" disabled={page<=1} onClick={()=>go(page-1)} aria-label="上一页"><ChevronLeft className="size-4"/></Button>
        <label className="flex items-center gap-2 text-sm">
          <input aria-label="当前页码" inputMode="numeric" className="h-8 w-14 rounded-md border bg-background px-2 text-center" value={page} onChange={event=>go(Number(event.target.value)||1)}/>
          <span className="whitespace-nowrap text-muted-foreground">/ {pages||'—'} 页</span>
        </label>
        <Button type="button" size="icon" variant="ghost" disabled={!pages||page>=pages} onClick={()=>go(page+1)} aria-label="下一页"><ChevronRight className="size-4"/></Button>
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" size="icon" variant="ghost" disabled={zoom<=0.6} onClick={()=>setZoom(value=>Math.max(0.6,Number((value-0.15).toFixed(2))))} aria-label="缩小"><ZoomOut className="size-4"/></Button>
        <button type="button" className="min-w-16 rounded-md px-2 py-1 text-sm hover:bg-muted" onClick={()=>setZoom(1)} aria-label="恢复原始缩放">{Math.round(zoom*100)}%</button>
        <Button type="button" size="icon" variant="ghost" disabled={zoom>=2} onClick={()=>setZoom(value=>Math.min(2,Number((value+0.15).toFixed(2))))} aria-label="放大"><ZoomIn className="size-4"/></Button>
        <Button type="button" size="icon" variant="ghost" onClick={()=>setRotation(value=>(value+90)%360)} aria-label="顺时针旋转"><RotateCw className="size-4"/></Button>
      </div>
    </div>
    <div ref={container} className="max-h-[78vh] min-h-[60vh] overflow-auto p-4">
      <Document file={source} onLoadSuccess={({numPages})=>{setPages(numPages);setPage(current=>Math.min(current,numPages));}} loading={<p className="py-24 text-center text-muted-foreground">正在加载 PDF…</p>} error={<div className="mx-auto max-w-lg rounded-xl border bg-background p-6 text-center"><strong>PDF 暂时无法显示</strong><p className="mt-2 text-sm text-muted-foreground">请刷新页面重试，或使用上方的“下载原件”。</p></div>}>
        <Page pageNumber={page} width={width*zoom} rotate={rotation} renderAnnotationLayer renderTextLayer className="mx-auto w-fit shadow-xl" loading={<p className="py-24 text-center text-muted-foreground">正在绘制第 {page} 页…</p>}/>
      </Document>
    </div>
    <p className="border-t bg-background/80 px-4 py-2 text-center text-xs text-muted-foreground">{name} · 可选中文字，使用浏览器查找功能搜索当前页面</p>
  </section>;
}
