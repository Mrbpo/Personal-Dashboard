'use client';

import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Button} from '@/components/ui/button';
import type {PdfFormulaReparseStatus} from '@/lib/pdf-formula-reparse';

export function PdfFormulaReparse({documentId,initialStatus}:{documentId:string;initialStatus:PdfFormulaReparseStatus}){
 const router=useRouter(),[state,setState]=useState(initialStatus),[sending,setSending]=useState(false),[error,setError]=useState('');
 const url=`/api/library/${encodeURIComponent(documentId)}/reparse-formulas`;
 useEffect(()=>{
  if(!['queued','running','busy'].includes(state.status))return;
  const timer=setInterval(()=>{void (async()=>{
   try{const response=await fetch(url,{cache:'no-store'});if(!response.ok)return;const next=await response.json() as PdfFormulaReparseStatus;setState(next);if(next.status==='complete')router.refresh();}catch{/* Keep current status until the connection returns. */}
  })();},4000);
  return ()=>clearInterval(timer);
 },[state.status,url,router]);
 if(state.status==='unavailable')return null;
 async function start(){
  setSending(true);setError('');
  try{
   const response=await fetch(url,{method:'POST'}),result=await response.json();
   if(!response.ok)throw new Error(result.error||'无法启动公式识别');
   setState(result as PdfFormulaReparseStatus);
  }catch(cause){setError(cause instanceof Error?cause.message:'无法启动公式识别');}
  finally{setSending(false);}
 }
 const active=['queued','running','busy'].includes(state.status);
 return <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
  {state.status!=='complete'&&<Button type="button" size="sm" variant="outline" disabled={sending||active} onClick={()=>void start()}>{state.status==='failed'?'重试公式识别':'重新识别这份 PDF 的公式'}</Button>}
  <p className="text-sm text-muted-foreground" role="status">{error||state.message}</p>
 </div>;
}
