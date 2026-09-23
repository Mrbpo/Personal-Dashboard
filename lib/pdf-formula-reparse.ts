import {database as db} from './database.ts';
import {getDocument} from './library.ts';
import {PDF_PARSER_VERSION} from './document-parser.ts';

export type PdfFormulaReparseStatus={status:'unavailable'|'idle'|'queued'|'running'|'busy'|'failed'|'complete';message:string};

export async function getPdfFormulaReparseStatus(owner:string,id:string):Promise<PdfFormulaReparseStatus>{
 const document=await getDocument(owner,id);
 if(document.mime!=='application/pdf')return {status:'unavailable',message:''};
 const versions=(await db.prepare("SELECT parser,COUNT(*) count FROM library_parse_pages WHERE document_id=? AND parser IN ('pdf-page-v2',?) GROUP BY parser").bind(id,PDF_PARSER_VERSION).all<{parser:string;count:number}>()).results;
 const hasOld=versions.some(row=>row.parser==='pdf-page-v2'&&row.count>0);
 const hasCurrent=versions.some(row=>row.parser===PDF_PARSER_VERSION&&row.count>0);
 if(!hasOld)return {status:'unavailable',message:''};
 const job=await db.prepare('SELECT status,payload FROM background_jobs WHERE id=?').bind(`index:${id}`).first<{status:string;payload:string}>();
 const requested=job?.payload?JSON.parse(job.payload).forcePdfFormulaReparse===true:false;
 if(requested&&job?.status==='queued')return {status:'queued',message:'已加入识别队列，原文字会保留'};
 if(requested&&job?.status==='running')return {status:'running',message:'正在逐页识别公式，原文字会保留'};
 if(requested&&job?.status==='failed')return {status:'failed',message:'公式识别失败，可重试；原文字仍可查看'};
 if(hasCurrent&&document.status==='ready')return {status:'complete',message:'公式识别已完成'};
 if(job&&(job.status==='queued'||job.status==='running'))return {status:'busy',message:'这份资料正在解析，请完成后再试'};
 return {status:'idle',message:'可为这份 PDF 单独重新识别公式'};
}

export async function queuePdfFormulaReparse(owner:string,id:string):Promise<PdfFormulaReparseStatus>{
 const before=await getPdfFormulaReparseStatus(owner,id);
 if(before.status==='unavailable')throw new Error('仅已解析的 PDF 可以重新识别公式');
 if(before.status==='complete'||before.status==='running'||before.status==='queued'||before.status==='busy')return before;
 const now=Date.now(),payload=JSON.stringify({owner,id,forcePdfFormulaReparse:true});
 // A single document uses the existing index job ID, so duplicate clicks cannot
 // create parallel paid requests. A generic queued index job is promoted here.
 await db.prepare(`INSERT INTO background_jobs (id,kind,payload,available_at,updated_at) VALUES (?,'index',?,?,?)
   ON CONFLICT(id) DO UPDATE SET kind='index',payload=excluded.payload,status='queued',attempts=0,error=NULL,available_at=excluded.available_at,lease_until=NULL,lease_token=NULL,updated_at=excluded.updated_at
   WHERE background_jobs.status IN ('complete','failed') OR (background_jobs.status='queued' AND background_jobs.payload<>excluded.payload)`).bind(`index:${id}`,payload,now,now).run();
 return getPdfFormulaReparseStatus(owner,id);
}
