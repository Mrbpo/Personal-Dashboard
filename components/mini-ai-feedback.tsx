'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';

export function MiniAiFeedback({sourceType,sourceId,metadata}:{sourceType:string;sourceId:string;metadata?:Record<string,unknown>}){
 const [rating,setRating]=useState(0),[reason,setReason]=useState(''),[open,setOpen]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function save(value:number,detail=reason){setBusy(true);try{const response=await fetch('/api/ai-feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceType,sourceId,rating:value,reason:detail,metadata})}),body=await response.json();if(!response.ok)throw new Error(body.error||'反馈保存失败');setRating(value);setMessage(value<0&&body.maintenanceTaskId?'已记录，服务器 Codex 将在今晚检查。':'已记录，会用于改进后续分析。');if(value>0)setOpen(false);}catch(error:any){setMessage(error.message);}finally{setBusy(false);}}
 return <div className="mt-3 border-t pt-2 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground">这段 AI 内容有帮助吗？</span><Button type="button" size="sm" variant={rating===1?'default':'outline'} disabled={busy} onClick={()=>void save(1)}>有帮助</Button><Button type="button" size="sm" variant={rating===-1?'default':'outline'} disabled={busy} onClick={()=>{setRating(-1);setOpen(true);}}>需改进</Button></div>{open&&<div className="mt-2 flex gap-2"><input className="min-w-0 flex-1 rounded border bg-background p-2" value={reason} onChange={event=>setReason(event.target.value)} placeholder="可选：哪里不准确或遗漏了？" maxLength={1000}/><Button type="button" size="sm" disabled={busy} onClick={()=>void save(-1)}>提交</Button></div>}{message&&<p className="mt-1 text-muted-foreground" role="status">{message}</p>}</div>;
}
