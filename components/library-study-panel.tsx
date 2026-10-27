'use client';

import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Button} from './ui/button';
import {StudyDocumentSidebar,type StudyLibraryDocument} from './study-document-sidebar';

type QueryMode='auto'|'document'|'facts'|'combined';
type Session={queryMode:QueryMode;documentIds:string[];revision:number};
type Citation={ref?:string;title?:string;url?:string;evidence?:{documentId?:string;locator?:string;physicalPage?:number;visual?:{physicalPage?:number};textContextObservation?:{physicalPage?:number};nativeRegionObservation?:{physicalPage?:number}}};
type Message={id:string;role:string;body:string;meta?:{citations?:Citation[];contextNote?:string}};
type StudyState={threadId?:string;threads:{id:string;title:string}[];messages:Message[];session?:Session|null};
type StudyResponse=StudyState&{state?:StudyState;answer?:Message;session?:Session|null};
const empty:StudyState={threads:[],messages:[]};
const modes:{value:QueryMode;label:string}[]=[{value:'auto',label:'自动选择'},{value:'document',label:'仅所选 PDF'},{value:'facts',label:'仅课程事实'},{value:'combined',label:'PDF 与课程事实'}];

async function readResponse(response:Response):Promise<StudyResponse>{
  const result=await response.json();
  if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'学习对话暂时不可用，请重试');
  return result;
}
function safeCitationUrl(url?:string){
  if(!url)return undefined;
  if(/^\/api\/library\/[A-Za-z0-9_-]+(?:\?|$)/.test(url))return url;
  try{const parsed=new URL(url);if(parsed.protocol==='https:'||parsed.protocol==='http:')return parsed.href;}catch{/* Unrecognized citations remain plain text. */}
  return undefined;
}
function readerUrl(citation:Citation){
  const evidence=citation.evidence;
  const locatorPage=typeof evidence?.locator==='string'?/^第 ([1-9]\d*) 页$/.exec(evidence.locator)?.[1]:undefined;
  const page=evidence?.physicalPage??evidence?.visual?.physicalPage??evidence?.textContextObservation?.physicalPage??evidence?.nativeRegionObservation?.physicalPage??(locatorPage?Number(locatorPage):undefined);
  if(typeof evidence?.documentId!=='string'||!Number.isSafeInteger(page)||Number(page)<1)return undefined;
  return `/library/${encodeURIComponent(evidence.documentId)}?page=${page}`;
}

export function LibraryStudyPanel({initialDocumentIds=[],embedded=false}:{initialDocumentIds?:string[];embedded?:boolean}){
  const initialKey=initialDocumentIds.join(',');
  const [data,setData]=useState<StudyState>(empty),[thread,setThread]=useState('');
  const [session,setSession]=useState<Session>({queryMode:'auto',documentIds:initialDocumentIds,revision:0});
  const [documents,setDocuments]=useState<StudyLibraryDocument[]>([]),[question,setQuestion]=useState('');
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[loadFailed,setLoadFailed]=useState(false),[error,setError]=useState(''),[libraryError,setLibraryError]=useState('');
  const request=useRef<{key:string;id:string}|null>(null),operation=useRef(false);

  function apply(result:StudyResponse,id?:string){
    const state=result.state??result;
    setData(current=>({threads:state.threads??current.threads,messages:state.messages??current.messages}));
    const nextSession=result.session??state.session;
    if(nextSession)setSession(nextSession);
    const nextThread=id??result.threadId??state.threadId;
    if(nextThread!==undefined)setThread(nextThread);
  }

  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setLoadFailed(false);setError('');setLibraryError('');setThread('');setData(empty);
    setSession({queryMode:'auto',documentIds:initialKey?initialKey.split(','):[],revision:0});
    const library=fetch('/api/library',{cache:'no-store',signal:controller.signal}).then(async response=>{
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'无法加载资料库');
      if(!Array.isArray(result))throw new Error('资料库返回格式无效');
      setDocuments(result.filter((item:StudyLibraryDocument)=>item.mime==='application/pdf'));
    }).catch(cause=>{if(!controller.signal.aborted)setLibraryError(cause instanceof Error?cause.message:'无法加载资料库');});
    const study=fetch('/api/v1/study'+(initialKey?`?documentId=${encodeURIComponent(initialKey.split(',')[0])}`:''),{cache:'no-store',signal:controller.signal})
      .then(readResponse).then(result=>{if(!controller.signal.aborted)apply(result);})
      .catch(cause=>{if(!controller.signal.aborted){setLoadFailed(true);setError(`${cause instanceof Error?cause.message:'无法读取学习对话'}。请刷新页面后重试。`);}});
    void Promise.all([library,study]).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[initialKey]);

  async function selectThread(id:string){
    if(operation.current)return;
    operation.current=true;setBusy(true);setError('');
    try{apply(await readResponse(await fetch(`/api/v1/study?threadId=${encodeURIComponent(id)}`,{cache:'no-store'})),id);setQuestion('');request.current=null;}
    catch(cause){setError(cause instanceof Error?cause.message:'无法读取学习对话');}
    finally{operation.current=false;setBusy(false);}
  }

  async function changeScope(next:Session){
    if(operation.current||loading)return;
    setError('');request.current=null;
    if(!thread){setSession(next);return;}
    operation.current=true;setBusy(true);
    try{
      const result=await readResponse(await fetch('/api/v1/study',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({threadId:thread,documentIds:next.documentIds,queryMode:next.queryMode,scopeRevision:session.revision})}));
      apply(result,thread);
    }catch(cause){setError(cause instanceof Error?cause.message:'无法保存检索范围');}
    finally{operation.current=false;setBusy(false);}
  }

  const unavailable=session.documentIds.filter(id=>!documents.some(document=>document.id===id&&document.status==='ready'));
  const needsDocument=(session.queryMode==='document'||session.queryMode==='combined')&&!session.documentIds.length;
  const pdfBlocked=session.queryMode!=='facts'&&(!!libraryError||unavailable.length>0);
  const disabled=busy||loading||loadFailed;
  async function send(){
    if(operation.current||loading||loadFailed||pdfBlocked||needsDocument||!question.trim())return;
    operation.current=true;setBusy(true);setError('');
    const key=JSON.stringify({thread,question:question.trim(),session});
    if(request.current?.key!==key)request.current={key,id:crypto.randomUUID()};
    try{
      const result=await readResponse(await fetch('/api/v1/study',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threadId:thread||undefined,question:question.trim(),requestId:request.current.id,documentIds:session.documentIds,queryMode:session.queryMode,scopeRevision:session.revision,online:false})}));
      const id=result.threadId??thread;
      apply(result,id);
      setQuestion('');request.current=null;
    }catch(cause){setError(cause instanceof Error?cause.message:'发送失败，请重试');}
    finally{operation.current=false;setBusy(false);}
  }

  return <section className="grid min-w-0 overflow-hidden rounded-2xl border bg-card lg:h-[calc(100dvh-13rem)] lg:min-h-[620px] lg:grid-cols-[300px_minmax(0,1fr)]" aria-label="资料学习对话">
    <StudyDocumentSidebar documents={documents} selectedIds={session.documentIds} disabled={disabled} loading={loading} libraryError={libraryError} onSelectionChange={documentIds=>void changeScope({...session,documentIds})}/>
    <div className="flex min-h-0 min-w-0 flex-col gap-4 p-4 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{embedded?'围绕这份 PDF 提问':'学习对话'}</h2><p className="mt-1 text-sm text-muted-foreground">选择资料库中的 PDF，或结合课程事实连续追问。</p></div><div className="flex gap-2">{embedded&&<Button asChild variant="outline"><Link href="/study">全部学习对话</Link></Button>}<Button disabled={disabled} variant="outline" onClick={()=>{setThread('');setData(current=>({...current,messages:[]}));setSession({queryMode:'auto',documentIds:initialKey?initialKey.split(','):[],revision:0});setQuestion('');request.current=null;setError('');}}>新对话</Button></div></div>
    {error&&<p role="alert" className="rounded-xl border border-amber-700/30 bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
    {libraryError&&<p role="alert" className="rounded-xl border border-amber-700/30 bg-amber-50 p-3 text-sm text-amber-900">{libraryError}。请刷新页面后重试。</p>}
    {loading&&<p role="status" className="text-sm text-muted-foreground">正在读取资料和对话…</p>}
    <div className="flex flex-wrap gap-4">
      <label className="min-w-48 flex-1 text-sm">已有对话<select aria-label="已有学习对话" disabled={disabled} value={thread} onChange={event=>void selectThread(event.target.value)} className="mt-1 w-full rounded-lg border bg-background p-2"><option value="" disabled>新对话</option>{data.threads.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label className="min-w-48 flex-1 text-sm">回答依据<select aria-label="回答依据" disabled={disabled} value={session.queryMode} onChange={event=>void changeScope({...session,queryMode:event.target.value as QueryMode})} className="mt-1 w-full rounded-lg border bg-background p-2">{modes.map(mode=><option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label>
    </div>
    <p className="line-clamp-2 break-words text-xs text-muted-foreground" title={session.documentIds.map(id=>documents.find(document=>document.id===id)?.name||id).join('、')}>本轮资料：{session.documentIds.length?session.documentIds.map(id=>documents.find(document=>document.id===id)?.name??'已不可用的资料').join('、'):'未选择 PDF'}{session.queryMode==='facts'?'；仅查询课程事实，PDF 选择会保留。':''}</p>
    {unavailable.length>0&&!loading&&session.queryMode!=='facts'&&<p role="alert" className="text-sm text-amber-800">所选 PDF 尚未就绪或已不可用。请等待解析完成后刷新，或清空所选 PDF 后重新选择。</p>}
    {needsDocument&&<p className="text-sm text-amber-800">请至少选择一份已就绪的 PDF。</p>}
    <div className="min-h-20 max-h-[60vh] flex-1 space-y-4 overflow-y-auto overscroll-contain lg:max-h-none" aria-live="polite">{data.messages.map(message=><article key={message.id} className={`rounded-xl p-4 ${message.role==='user'?'ml-6 bg-primary/10':'border bg-background'}`}><p className="mb-2 text-xs text-muted-foreground">{message.role==='user'?'你':'学习助手'}</p><div className="whitespace-pre-wrap break-words text-sm leading-7">{message.body}</div>{message.meta?.citations?.map((citation,index)=>{const proof=safeCitationUrl(citation.url),reader=readerUrl(citation);return <div key={`${citation.ref??index}:${index}`} className="mt-2 flex flex-wrap gap-x-3 text-xs">{proof?<a className="underline" href={proof} target="_blank" rel="noreferrer">[{citation.ref??index+1}] {citation.title??'核对引用'}</a>:<span>[{citation.ref??index+1}] {citation.title??'引用'}</span>}{reader&&<Link className="underline" href={reader}>打开 PDF 原页</Link>}</div>;})}{message.meta?.contextNote&&<p className="mt-3 text-xs text-muted-foreground">{message.meta.contextNote}</p>}</article>)}{busy&&<p role="status" className="text-sm text-muted-foreground">正在保存范围或检索并生成回答…</p>}</div>
    <form onSubmit={event=>{event.preventDefault();void send();}} className="space-y-3"><label className="block text-sm">问题<textarea aria-label="学习问题" className="mt-1 w-full rounded-xl border bg-background p-3" rows={embedded?3:4} maxLength={6000} disabled={disabled} value={question} onChange={event=>setQuestion(event.target.value)} placeholder="解释这个概念，或继续追问……"/></label><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">使用已保存的对话与所选依据，不联网补充。</p><Button type="submit" disabled={disabled||pdfBlocked||needsDocument||!question.trim()}>发送</Button></div></form>
    </div>
  </section>;
}
