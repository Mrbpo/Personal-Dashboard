import { database as legacy } from '../database.ts';
import { getDocument, readBlob, splitText } from '../library.ts';
import { kernel } from './service.ts';

type Page = { locator: string; text: string };

function pagesFromResult(result: Record<string, unknown>): Page[] {
  const document=result.document as Record<string,unknown>|undefined;
  const json=document?.json_content as Record<string,unknown>|undefined;
  const texts=Array.isArray(json?.texts)?json.texts as Array<Record<string,unknown>>:[];
  const grouped=new Map<number,string[]>();
  for(const item of texts){
    const prov=Array.isArray(item.prov)?item.prov[0] as Record<string,unknown>|undefined:undefined;
    const page=Number(prov?.page_no);
    const content=String(item.text||'').trim();
    if(!Number.isInteger(page)||page<1||!content)continue;
    grouped.set(page,[...(grouped.get(page)||[]),content]);
  }
  if(grouped.size)return [...grouped.entries()].sort((a,b)=>a[0]-b[0]).map(([page,parts])=>({locator:`第 ${page} 页`,text:parts.join('\n\n')}));
  const markdown=String(document?.md_content||document?.text_content||'').trim();
  return markdown?[{locator:'正文',text:markdown}]:[];
}

export async function convertDocumentWithDocling(owner: string, id: string): Promise<void> {
  const base=process.env.DOCLING_URL;
  if(!base)throw new Error('DOCLING_URL is required for v1 PDF parsing');
  const document=await getDocument(owner,id);
  if(document.mime!=='application/pdf')return;
  const bytes=await readBlob(document.hash);
  const form=new FormData();
  form.append('files',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),document.name);
  form.append('from_formats','pdf');
  form.append('to_formats','md');
  form.append('to_formats','json');
  form.append('do_ocr','true');
  const headers:HeadersInit=process.env.DOCLING_API_KEY?{'X-Api-Key':process.env.DOCLING_API_KEY}:{};
  const endpoint=base.replace(/\/$/,'');
  const submitted=await fetch(`${endpoint}/v1/convert/file/async`,{method:'POST',headers,body:form,signal:AbortSignal.timeout(120000)});
  if(!submitted.ok)throw new Error(`Docling submit failed (${submitted.status})`);
  const task=await submitted.json() as {task_id?:string;task_status?:string};
  if(!task.task_id)throw new Error('Docling did not return a task id');
  let state=task.task_status;
  for(let attempt=0;attempt<180 && state!=='success' && state!=='failure';attempt++){
    await new Promise(resolve=>setTimeout(resolve,5000));
    const polled=await fetch(`${endpoint}/v1/status/poll/${encodeURIComponent(task.task_id)}`,{headers,signal:AbortSignal.timeout(15000)});
    if(!polled.ok)throw new Error(`Docling poll failed (${polled.status})`);
    state=(await polled.json() as {task_status?:string}).task_status;
  }
  if(state!=='success')throw new Error(`Docling conversion ${state||'timed out'}`);
  const response=await fetch(`${endpoint}/v1/result/${encodeURIComponent(task.task_id)}`,{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Docling result failed (${response.status})`);
  const result=await response.json() as Record<string,unknown>;
  if(result.status!=='success' && result.status!=='partial_success')throw new Error('Docling returned no successful document');
  const pages=pagesFromResult(result);
  if(!pages.length)throw new Error('Docling returned no readable text');
  await kernel.ingestParsedDocument({id:document.id,courseId:document.course_id,name:document.name,
    hash:document.hash,mime:document.mime,origin:document.origin,originKey:document.origin_key},pages);
  const chunks=pages.flatMap(page=>splitText(page.text).map(body=>({locator:page.locator,body})));
  // Search chunks are a rebuildable cache. The original blob and provenance remain available.
  await legacy.batch([
    legacy.prepare("DELETE FROM library_parse_pages WHERE document_id=? AND parser='docling-v1'").bind(id),
    ...pages.map((page,index)=>legacy.prepare('INSERT INTO library_parse_pages(document_id,parser,page,body) VALUES (?,?,?,?)')
      .bind(id,'docling-v1',index,page.text)),
    legacy.prepare('DELETE FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(id),
    legacy.prepare('DELETE FROM library_chunks WHERE document_id=?').bind(id),
    ...chunks.map((chunk,index)=>legacy.prepare('INSERT INTO library_chunks(id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:${index}`,id,index,chunk.locator,chunk.body,document.hash)),
    legacy.prepare("UPDATE library_documents SET status='ready',error=NULL WHERE id=? AND deleted=0").bind(id),
  ]);
}
