import { database as legacy } from '../database.ts';
import { PDFArray, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { digest, getDocument, readBlob, splitText } from '../library.ts';
import { kernel } from './service.ts';
import { decodeDoclingResult, DOCLING_PARSER_VERSION, DOCLING_TEXT_PARSER_VERSION } from './docling-result.ts';
import {rememberDoclingTask} from './jobs.ts';
import {enrichParsedPdfFormulae,transcribePdfVisualPages} from '../document-parser.ts';
import {localPdfTextPages} from '../local-ocr.ts';

export function nativePdfTextIsComplete(pages:string[]|null,expectedPages:number,blankPages:number[]=[]):boolean{
  if(!pages||pages.length!==expectedPages)return false;
  const fingerprint=(line:string)=>line.toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
  const repeated=new Map<string,number>();
  for(const page of pages){
    const lines=page.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    for(const key of new Set([...lines.slice(0,3),...lines.slice(-3)].map(fingerprint)))
      repeated.set(key,(repeated.get(key)||0)+1);
  }
  // Repeated headers/footer labels may exceed 300 characters on four-up scans.
  // Count unique prose, rather than accepting the size of those repeated labels.
  const meaningful=pages.map(page=>page.split(/\r?\n/).filter(line=>
    (repeated.get(fingerprint(line))||0)<Math.max(2,Math.ceil(expectedPages*.6))).join('\n').replace(/\s+/g,' ').trim());
  return meaningful.every((page,index)=>page.length>=40||blankPages.includes(index+1))&&
    meaningful.filter(page=>page.length>=300).length>expectedPages*.5;
}

export async function convertDocumentWithDocling(owner: string, id: string, job?:{id:string;leaseToken:string;taskId?:string;formulaEnriched?:boolean;formulaBackend?:string;scanBackend?:string},savedResult?:Record<string,unknown>,savedTaskId?:string): Promise<void> {
  const base=process.env.DOCLING_URL;
  if(!base)throw new Error('DOCLING_URL is required for v1 PDF parsing');
  const document=await getDocument(owner,id);
  if(document.mime!=='application/pdf')return;
  const bytes=await readBlob(document.hash);
  const originalPdf=await PDFDocument.load(bytes,{updateMetadata:false});
  const originalPages=originalPdf.getPageCount();
  if(originalPages>500)throw new Error('PDF 超过 500 页，请分册导入');
  const verifiedBlankPages=originalPdf.getPages().flatMap((page,index)=>{
    // Absence of extracted objects is not evidence of a blank scan. Only accept pages
    // with no drawing/text stream and no annotation appearance in the original PDF.
    if(page.node.Annots()?.size())return [];
    const contents=page.node.Contents();
    const streams=contents instanceof PDFArray?contents.asArray().map(ref=>originalPdf.context.lookup(ref)):[contents];
    const blank=streams.every(stream=>stream===undefined || (stream instanceof PDFStream &&
      (stream.getContentsSize()===0 || (!stream.dict.has(PDFName.of('Filter')) && !stream.getContentsString().trim()))));
    return blank?[index+1]:[];
  });
  const form=new FormData();
  form.append('files',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),document.name);
  form.append('from_formats','pdf');
  form.append('to_formats','md');
  form.append('to_formats','json');
  form.append('do_ocr','true');
  form.append('do_table_structure','true');
  const formulaEnriched=job?.formulaEnriched??(process.env.DOCLING_FORMULA_ENRICHMENT!=='false');
  const formulaBackend=job?.formulaBackend||process.env.DOCLING_FORMULA_BACKEND||'ai';
  if(!['ai','docling'].includes(formulaBackend))throw new Error('Unknown PDF formula backend');
  const localFormula=formulaEnriched&&formulaBackend==='docling';
  form.append('do_formula_enrichment',String(localFormula));
  form.append('code_formula_preset',process.env.DOCLING_FORMULA_PRESET||'codeformulav2');
  form.append('abort_on_error','true');
  const headers:HeadersInit=process.env.DOCLING_API_KEY?{'X-Api-Key':process.env.DOCLING_API_KEY}:{};
  const endpoint=base.replace(/\/$/,'');
  const native=localFormula||process.env.DOCLING_NATIVE_TEXT_FASTPATH==='false'||savedResult||job?.taskId||savedTaskId?null:await localPdfTextPages(bytes);
  // Do not OCR a healthy embedded text layer. Sparse scans and image-only pages
  // still require Docling; short native headers alone do not qualify.
  const nativeComplete=nativePdfTextIsComplete(native,originalPages,verifiedBlankPages);
  const scanBackend=job?.scanBackend||process.env.PDF_SCAN_TRANSCRIPTION_BACKEND||'docling';
  if(!['ai','docling'].includes(scanBackend))throw new Error('Unknown PDF scan backend');
  const visual=!nativeComplete&&scanBackend==='ai';
  let result=savedResult;
  if(!result&&!nativeComplete&&!visual){
  let task:{task_id?:string;task_status?:string}={task_id:job?.taskId||savedTaskId};
  if(!task.task_id){
    const submitted=await fetch(`${endpoint}/v1/convert/file/async`,{method:'POST',headers,body:form,signal:AbortSignal.timeout(120000)});
    if(!submitted.ok)throw new Error(`Docling submit failed (${submitted.status})`);
    task=await submitted.json() as typeof task;
    if(!task.task_id)throw new Error('Docling did not return a task id');
    if(job)await rememberDoclingTask(job.id,job.leaseToken,task.task_id);
  }
  let state=task.task_status;
  const until=Date.now()+15*60000;let transientErrors=0;
  while(Date.now()<until && state!=='success' && state!=='failure'){
    await new Promise(resolve=>setTimeout(resolve,5000));
    let polled:Response;
    try{polled=await fetch(`${endpoint}/v1/status/poll/${encodeURIComponent(task.task_id)}`,{headers,signal:AbortSignal.timeout(30000)});}
    catch(error){if(++transientErrors>8)throw error;continue;}
    if(polled.status>=500&&++transientErrors<=8)continue;
    transientErrors=0;
    if(!polled.ok){
      if(job&&polled.status===404)await rememberDoclingTask(job.id,job.leaseToken,null);
      throw new Error(`Docling poll failed (${polled.status})`);
    }
    state=(await polled.json() as {task_status?:string}).task_status;
  }
  if(state!=='success'){
    if(job&&state==='failure')await rememberDoclingTask(job.id,job.leaseToken,null);
    throw new Error(`Docling conversion ${state||'timed out'}`);
  }
  const response=await fetch(`${endpoint}/v1/result/${encodeURIComponent(task.task_id)}`,{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok){
    if(job&&response.status===404)await rememberDoclingTask(job.id,job.leaseToken,null);
    throw new Error(`Docling result failed (${response.status})`);
  }
  result=await response.json() as Record<string,unknown>;
  }
  const decoded=visual?{pages:await transcribePdfVisualPages(id,bytes),totalPages:originalPages,
    warnings:['AI 视觉转写；数学、手写及图表请核对原 PDF'],formulaPageNumbers:[]}:
    nativeComplete?{pages:native!.map((text,index)=>({text,pageNumber:index+1,locator:`第 ${index+1} 页`})),
    totalPages:originalPages,warnings:formulaEnriched?[]:['公式增强未启用；正文可检索，公式须核对原 PDF'],formulaPageNumbers:[]}:
    decodeDoclingResult(result,originalPages,{verifiedBlankPages,formulaEnriched:localFormula});
  let pages=decoded.pages,warnings=decoded.warnings;
  const totalPages=decoded.totalPages;
  if(visual)warnings=[...warnings,...pages.filter(page=>page.text.includes('[无法可靠辨认')).map(page=>`第 ${page.pageNumber} 页含无法可靠辨认的片段，须核对原 PDF`)];
  if(formulaEnriched&&!visual&&(!localFormula||nativeComplete)){
    const enhanced=await enrichParsedPdfFormulae(id,bytes,pages,decoded.formulaPageNumbers);
    pages=enhanced.pages;
    warnings=[...warnings.filter(warning=>!warning.startsWith('公式增强未启用')), ...enhanced.warnings];
  }
  const parserVersion=formulaEnriched?DOCLING_PARSER_VERSION:DOCLING_TEXT_PARSER_VERSION;
  await getDocument(owner,id); // Do not publish a conversion for a deleted original.
  await kernel.ingestParsedDocument({id:document.id,ownerId:owner,courseId:document.course_id,name:document.name,
    hash:document.hash,mime:document.mime,origin:document.origin,originKey:document.origin_key,createdAt:document.created_at},pages,
    {parserVersion,expectedPages:totalPages,warnings,extractionMethod:visual?'ai-visual-page-transcription':nativeComplete?
      (formulaEnriched?'native-text-plus-ai-formula':'native-text'):formulaEnriched?`docling-plus-${formulaBackend}-formula`:'docling-text'});
  const chunks=pages.flatMap(page=>splitText(page.text).map(body=>({locator:page.locator,body})));
  // Search chunks are a rebuildable cache. The original blob and provenance remain available.
  await legacy.batch([
    legacy.prepare('DELETE FROM library_parse_pages WHERE document_id=? AND parser IN (?,?)').bind(id,'docling-v1',parserVersion),
    ...pages.map(page=>legacy.prepare('INSERT INTO library_parse_pages(document_id,parser,page,body) VALUES (?,?,?,?)')
      .bind(id,parserVersion,page.pageNumber-1,page.text)),
    legacy.prepare('DELETE FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(id),
    legacy.prepare('DELETE FROM library_chunks WHERE document_id=?').bind(id),
    ...chunks.map((chunk,index)=>legacy.prepare('INSERT INTO library_chunks(id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:${index}`,id,index,chunk.locator,chunk.body,digest(chunk.body))),
    legacy.prepare("UPDATE library_documents SET status='ready',error=? WHERE id=? AND deleted=0").bind(warnings.join('；')||null,id),
  ]);
}
