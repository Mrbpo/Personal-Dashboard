import {database as db} from './database.ts';
import {getDocument,indexDocument} from './library.ts';
import {PDF_PARSER_VERSION,pdfFormulaPageNeedsRecovery} from './document-parser.ts';
import {DOCLING_PARSER_VERSION,configuredDoclingParser} from './kernel/docling-result.ts';
import {kernelPool} from './kernel/db.ts';
import {kernel} from './kernel/service.ts';

export type PdfFormulaReparseStatus={status:'unavailable'|'idle'|'queued'|'running'|'busy'|'failed'|'complete';message:string};

export async function getPdfFormulaReparseStatus(owner:string,id:string):Promise<PdfFormulaReparseStatus>{
 const document=await getDocument(owner,id);
 if(document.mime!=='application/pdf')return {status:'unavailable',message:''};
 if(process.env.DOCLING_URL){
  const versions=(await db.prepare('SELECT parser,COUNT(*) count FROM library_parse_pages WHERE document_id=? GROUP BY parser')
   .bind(id).all<{parser:string;count:number}>()).results;
  const persisted=await kernel.parsedDocument(owner,id);
  const hasCurrent=persisted.length>0&&persisted[0].parser_version===configuredDoclingParser();
  const job=(await kernelPool().query<{state:string}>(
   "SELECT state FROM ingestion_jobs WHERE kind='docling_document' AND idempotency_key=$1",
   [`docling:${id}:${document.hash}:${configuredDoclingParser()}`])).rows[0];
  if(job?.state==='queued')return {status:'queued',message:'已加入文档识别队列，原文字会保留'};
  if(job?.state==='running')return {status:'running',message:'正在识别 PDF 文字、表格和公式，原文字会保留'};
  if(job?.state==='failed')return {status:'failed',message:'文档识别失败，可重试；原文字仍可查看'};
  if(hasCurrent&&document.status==='ready'){
   if(persisted[0].warnings.some(warning=>warning.includes('公式识别不完整')))return {status:'idle',message:'正文已保存；部分公式未完整识别，可重试并核对原 PDF'};
   return {status:'complete',message:configuredDoclingParser()===DOCLING_PARSER_VERSION?'文字、表格和公式识别已完成':'文字和表格识别已完成；公式须核对原 PDF'};
  }
  if(job?.state==='complete')return {status:'failed',message:'解析任务已结束，但未找到完整的文字索引，可重试'};
  const legacyJob=await db.prepare('SELECT status FROM background_jobs WHERE id=?').bind(`index:${id}`).first<{status:string}>();
  if(legacyJob?.status==='queued'||legacyJob?.status==='running')return {status:'busy',message:'这份资料正在加入解析队列，请完成后再试'};
  if(!versions.length&&!persisted.length)return {status:'unavailable',message:''};
  return {status:'idle',message:'可为这份 PDF 重新识别文字、表格和公式'};
 }
 const versions=(await db.prepare("SELECT parser,COUNT(*) count FROM library_parse_pages WHERE document_id=? AND parser IN ('pdf-page-v2',?) GROUP BY parser").bind(id,PDF_PARSER_VERSION).all<{parser:string;count:number}>()).results;
 const hasOld=versions.some(row=>row.parser==='pdf-page-v2'&&row.count>0);
 const hasCurrent=versions.some(row=>row.parser===PDF_PARSER_VERSION&&row.count>0);
 if(!hasOld&&!hasCurrent)return {status:'unavailable',message:''};
 const job=await db.prepare('SELECT status,payload FROM background_jobs WHERE id=?').bind(`index:${id}`).first<{status:string;payload:string}>();
 const requested=job?.payload?JSON.parse(job.payload).forcePdfFormulaReparse===true:false;
 if(requested&&job?.status==='queued')return {status:'queued',message:'已加入识别队列，原文字会保留'};
 if(requested&&job?.status==='running')return {status:'running',message:'正在逐页识别公式，原文字会保留'};
 if(requested&&job?.status==='failed')return {status:'failed',message:'公式识别失败，可重试；原文字仍可查看'};
 if(hasCurrent&&document.status==='ready'){
  const pages=(await db.prepare('SELECT page,body FROM library_parse_pages WHERE document_id=? AND parser=?').bind(id,PDF_PARSER_VERSION).all<{page:number;body:string}>()).results;
  for(const page of pages)if(await pdfFormulaPageNeedsRecovery(id,document.hash,page.page+1,page.body))
   return {status:'idle',message:'正文与原告警已保存；部分公式未完整识别，可手动重试并核对原 PDF'};
  return {status:'complete',message:'公式补充步骤已完成；机器公式仍须核对原 PDF，历史告警保留'};
 }
 if(job&&(job.status==='queued'||job.status==='running'))return {status:'busy',message:'这份资料正在解析，请完成后再试'};
 return {status:'idle',message:'可为这份 PDF 单独重新识别公式'};
}

export async function queuePdfFormulaReparse(owner:string,id:string):Promise<PdfFormulaReparseStatus>{
 const before=await getPdfFormulaReparseStatus(owner,id);
 if(before.status==='unavailable')throw new Error('仅已解析的 PDF 可以重新识别公式');
 if(before.status==='complete'||before.status==='running'||before.status==='queued'||before.status==='busy')return before;
 if(process.env.DOCLING_URL){
  await indexDocument(owner,id,true);
  return getPdfFormulaReparseStatus(owner,id);
 }
 const now=Date.now(),payload=JSON.stringify({owner,id,forcePdfFormulaReparse:true});
 // A single document uses the existing index job ID, so duplicate clicks cannot
 // create parallel paid requests. A generic queued index job is promoted here.
 await db.prepare(`INSERT INTO background_jobs (id,kind,payload,available_at,updated_at) VALUES (?,'index',?,?,?)
   ON CONFLICT(id) DO UPDATE SET kind='index',payload=excluded.payload,status='queued',attempts=0,error=NULL,available_at=excluded.available_at,lease_until=NULL,lease_token=NULL,updated_at=excluded.updated_at
   WHERE background_jobs.status IN ('complete','failed') OR (background_jobs.status='queued' AND background_jobs.payload<>excluded.payload)`).bind(`index:${id}`,payload,now,now).run();
 return getPdfFormulaReparseStatus(owner,id);
}

/** Keep the last searchable parse available when a replacement conversion fails. */
export async function recordDoclingParseFailure(id:string):Promise<void>{
 const document=await db.prepare('SELECT owner_id FROM library_documents WHERE id=? AND deleted=0').bind(id).first<{owner_id:string}>();
 const persisted=document&&process.env.KERNEL_DATABASE_URL?(await kernel.parsedDocument(document.owner_id,id)).some(page=>page.body.trim()):false;
 const previous=persisted||await db.prepare(`SELECT 1 ok FROM library_documents d WHERE d.id=? AND d.deleted=0
  AND EXISTS (SELECT 1 FROM library_parse_pages p WHERE p.document_id=d.id AND trim(p.body)<>'')
  AND EXISTS (SELECT 1 FROM library_chunks c WHERE c.document_id=d.id AND trim(c.body)<>'')`).bind(id).first();
 await db.prepare('UPDATE library_documents SET status=?,error=? WHERE id=? AND deleted=0').bind(
  previous?'ready':'error',previous?'文档重新解析失败；已保留之前可检索的文字，可重试':'文档解析失败，请检查 Docling 服务',id).run();
}
