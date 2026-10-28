'use client';
import {useEffect,useState} from 'react';
type Metadata={available:boolean;partial?:boolean;clipStartMs?:number;clipEndMs?:number};
function time(ms:number){return `${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;}
export function RecordingStudyGuide({viewId}:{viewId:string}){
 const [state,setState]=useState<{id:string;metadata:Metadata}|null>(null);
 useEffect(()=>{
  if(!viewId)return;const controller=new AbortController();
  void fetch(`/api/recordings/${encodeURIComponent(viewId)}/guide`,{cache:'no-store',signal:controller.signal}).then(async r=>{
   if(r.ok){const metadata=await r.json() as Metadata;if(!controller.signal.aborted)setState({id:viewId,metadata});}
  }).catch(()=>undefined);
  return ()=>controller.abort();
 },[viewId]);
 const metadata=state?.id===viewId?state.metadata:null;
 if(!metadata?.available)return null;
 const base=`/api/recordings/${encodeURIComponent(viewId)}/guide`;
 return <aside aria-label="学习讲义" className="mt-5 border-t pt-4">
  <h3 className="text-sm font-medium">学习讲义{metadata.partial?' · 已校订片段':''}</h3>
  <p className="my-2 text-xs text-muted-foreground">{metadata.partial?`仅覆盖 ${time(metadata.clipStartMs??0)}–${time(metadata.clipEndMs??0)}，不代表完整课程。`:'覆盖本节课程。'}原图、折叠中英转写、详细讲解及内容提纲。</p>
  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm underline">
   <a href={`${base}?format=html`} target="_blank" rel="noreferrer">阅读讲义</a>
   <a href={`${base}?format=pdf&download=1`}>下载讲义 PDF</a>
   <a href={`${base}?format=outlinePdf&download=1`}>下载提纲 PDF</a>
   <a href={`${base}?format=outlineText&download=1`}>下载提纲文本</a>
  </div>
 </aside>;
}
