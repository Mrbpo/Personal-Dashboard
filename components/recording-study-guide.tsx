'use client';
import {useEffect,useState} from 'react';

type Metadata = {
  available:boolean;
  reviewed?:boolean;
  partial?:boolean;
  clipStartMs?:number;
  clipEndMs?:number;
  version?:string;
  hasReviewed?:boolean;
  courseName?:string;
  publishedAt?:number|null;
};
const toronto = new Intl.DateTimeFormat('zh-CN',{
  timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
function time(ms:number) {
  return `${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
}
function ReviewedGuideLinks({base}:{base:string}) {
  const url = base+'?edition=reviewed&format=';
  return <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm underline">
    <a href={url+'html'} target="_blank" rel="noreferrer">阅读已校订样例</a>
    <a href={url+'pdf&download=1'}>下载样例 PDF</a>
    <a href={url+'outlinePdf&download=1'}>下载提纲 PDF</a>
    <a href={url+'outlineText&download=1'}>下载提纲文本</a>
  </div>;
}
export function RecordingStudyGuide({viewId}:{viewId:string|null}) {
  const [state,setState] = useState<{id:string;data:Metadata|null}|null>(null);
  const base = viewId ? `/api/recordings/${encodeURIComponent(viewId)}/guide` : null;
  useEffect(()=>{
    if(!base||!viewId)return;
    let active:AbortController;
    async function load(url:string,id:string) {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      try {
        const response = await fetch(url,{cache:'no-store',signal:controller.signal});
        if(!response.ok) throw Error();
        const data:Metadata = await response.json();
        if(!controller.signal.aborted) setState({id,data});
      } catch {
        if(!controller.signal.aborted) setState({id,data:null});
      }
    }
    void load(base,viewId);
    const onVisible = ()=>{if(document.visibilityState==='visible')void load(base,viewId);};
    document.addEventListener('visibilitychange',onVisible);
    return ()=>{active?.abort();document.removeEventListener('visibilitychange',onVisible);};
  },[base,viewId]);
  const data = state?.id===viewId ? state?.data : undefined;
  const auto = data?.available&&data.version;
  const reviewedOnly = data?.available&&data.reviewed;
  return <aside aria-label="课件与转写" className="mt-5 border-t pt-4">
    <h3 className="text-sm font-medium">课件与转写</h3>
    {auto&&base&&<>
      <p className="my-2 text-xs text-muted-foreground">{data.courseName} · {data.publishedAt!=null
        ? `录像发布于 ${toronto.format(data.publishedAt*1000)}（多伦多时间）` : '录像发布时间未知'}
        {data.partial&&` · ${time(data.clipStartMs??0)}–${time(data.clipEndMs??0)}`}</p>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm underline">
        <a href={`${base}?version=${data.version}&format=html`} target="_blank" rel="noreferrer">查看课件与转写</a>
        <a href={`${base}?version=${data.version}&format=pdf&download=1`}>下载 PDF</a>
      </div>
      {data.hasReviewed&&<details className="mt-2 text-sm"><summary>已校订样例</summary><ReviewedGuideLinks base={base}/></details>}
    </>}
    {reviewedOnly&&base&&<>
      <p className="my-2 text-xs text-muted-foreground">已校订样例 · {time(data.clipStartMs??0)}–{time(data.clipEndMs??0)}</p>
      <ReviewedGuideLinks base={base}/>
    </>}
    {!auto&&!reviewedOnly&&<p className="my-2 text-xs text-muted-foreground" role="status">
      {!viewId?'暂无可用的课件视角':data===null?'课件与转写暂时无法读取':data===undefined?'正在读取…':'尚未归档'}
    </p>}
  </aside>;
}
