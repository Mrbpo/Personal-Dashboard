'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {filesApi,type FileNode,type TreeResponse} from '@/lib/course-file-tree';

async function readDirectory(url:string,signal:AbortSignal):Promise<TreeResponse>{
  const response=await fetch(url,{cache:'no-store',signal});
  if(!response.ok)throw Error('无法读取目录');
  return response.json();
}
function Directory({url,refresh}:{url:string;refresh:number}){
  const [result,setResult]=useState<TreeResponse|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const abort=new AbortController();
    setResult(null);setFailed(false);
    readDirectory(url,abort.signal).then(data=>{if(!abort.signal.aborted)setResult(data);})
      .catch(()=>{if(!abort.signal.aborted)setFailed(true);});
    return ()=>abort.abort();
  },[url,refresh]);
  if(failed)return <p role="alert">目录读取失败，请重新展开。</p>;
  if(!result)return <p role="status">正在读取…</p>;
  return <>{result.warning&&<p role="status">{result.warning}</p>}
    {result.entries.length?<Nodes nodes={result.entries} refresh={refresh}/>:<p>目录为空</p>}</>;
}
const date=new Intl.DateTimeFormat('zh-CN',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function Branch({node,refresh}:{node:FileNode;refresh:number}){
  const [open,setOpen]=useState(false);
  if(node.downloadUrl)return <a className="underline break-all" href={node.downloadUrl} download>{node.name}</a>;
  return <details onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer">{node.name}{node.publishedAt!=null&&' · '+date.format(node.publishedAt*1000)+' 多伦多'}</summary>
    {open&&<div className="ml-3 border-l pl-3">{node.childrenUrl?<Directory url={node.childrenUrl} refresh={refresh}/>:<Nodes nodes={node.children??[]} refresh={refresh}/>}</div>}
  </details>;
}
function Nodes({nodes,refresh}:{nodes:FileNode[];refresh:number}){
  return <ul className="space-y-1 py-1">{nodes.map(node=><li key={node.id}><Branch node={node} refresh={refresh}/></li>)}</ul>;
}

export function CourseFileBrowser({courses}:{courses:{id:string;name:string}[]}){
  const [refresh,bump]=useState(0),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[download,setDownload]=useState('');
  async function upload(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget, data=new FormData(form);
    setBusy(true);setMessage('');setDownload('');
    try{
      const file=data.get('file');
      if(!(file instanceof File)||!file.size||file.size>50*1024*1024)throw Error('请选择不超过 50 MiB 的非空文件');
      const response=await fetch(filesApi,{method:'POST',body:data});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'上传失败');
      setDownload(result.downloadUrl);setMessage('已上传 '+result.name);bump(v=>v+1);
      const input=form.elements.namedItem('file') as HTMLInputElement;
      input.value='';
    }catch(error){setMessage(error instanceof Error?error.message:'上传失败');}
    finally{setBusy(false);}
  }
  return <div className="space-y-5"><form onSubmit={upload} className="flex flex-wrap items-end gap-3 rounded-xl border p-4">
    <label>课程<select name="courseId" className="block rounded border p-1"><option value="">未分课程</option>
      {courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label>资料目录<input className="block rounded border p-1" name="folderPath" defaultValue="上传" required/></label>
    <label>文件<input className="block" type="file" name="file" required/></label>
    <button className="rounded border px-3 py-1" disabled={busy}>{busy?'上传中…':'上传'}</button>
    {message&&<p role="status">{message} {download&&<a className="underline" href={download}>下载</a>}</p>}
  </form><Directory url={filesApi} refresh={refresh}/></div>;
}
