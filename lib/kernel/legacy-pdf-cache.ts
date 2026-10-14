import {createHash} from 'node:crypto';
import {PDFArray,PDFDocument,PDFName,PDFStream} from 'pdf-lib';
import {kernel} from './service.ts';
import {kernelPool} from './db.ts';
import {queueIngestionJob} from './jobs.ts';

export type LegacyPdfDocument={id:string;owner_id:string;course_id:string;name:string;hash:string;mime:string;
 origin:string;origin_key:string;created_at:string;status:string;error:string|null};
export type LegacyPdfPage={parser:string;page:number;body:string};
type Candidate={parser:string;parserVersion:string;extractionMethod:string;warnings:string[];
 pages:Array<{pageNumber:number;locator:string;text:string}>};
export type LegacyPdfAudit={documentId:string;ownerId:string;sourceHash:string;originalPages:number|null;
 decision:'eligible'|'needs_parse';reason:string;candidate?:Candidate};
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
// These implementations copy original page index `page` and persist that index:
// 328f63e (v1), 8e76994/9006b80 (v2), ea2bb4f (v3). Never mix parsers.
// docling-v1 renumbered a possibly partial result array, so it is not trusted here.
const physicalPageParsers=['pdf-page-v3-latex','pdf-page-v2','pdf-page-v1'];

export async function auditLegacyPdfCache(document:LegacyPdfDocument,rows:LegacyPdfPage[],bytes:Uint8Array):Promise<LegacyPdfAudit>{
 const result:LegacyPdfAudit={documentId:document.id,ownerId:document.owner_id,sourceHash:document.hash,
  originalPages:null,decision:'needs_parse',reason:'No verified complete physical-page cache'};
 if(document.mime!=='application/pdf'||sha(bytes)!==document.hash)return {...result,reason:'Original PDF checksum mismatch'};
 let pdf:PDFDocument;
 try{pdf=await PDFDocument.load(bytes,{updateMetadata:false});}catch{return {...result,reason:'Original PDF cannot be read'};}
 const count=pdf.getPageCount();result.originalPages=count;
 if(count<1||count>500)return {...result,reason:'Original PDF page count is outside supported range'};
 if(document.status!=='ready')return {...result,reason:'Legacy document is not ready; cached pages are not published as complete'};
 const blank=pdf.getPages().map(page=>{
  if(page.node.Annots()?.size())return false;
  const contents=page.node.Contents();
  const streams=contents instanceof PDFArray?contents.asArray().map(ref=>pdf.context.lookup(ref)):[contents];
  return streams.every(stream=>stream===undefined||(stream instanceof PDFStream&&
   (stream.getContentsSize()===0||(!stream.dict.has(PDFName.of('Filter'))&&!stream.getContentsString().trim()))));
 });
 for(const parser of physicalPageParsers){
  const cached=rows.filter(row=>row.parser===parser).sort((a,b)=>a.page-b.page);
  if(cached.length!==count||cached.some((row,index)=>!Number.isInteger(row.page)||row.page!==index||typeof row.body!=='string'))continue;
  if(cached.some(row=>(!row.body.trim()&&!blank[row.page])||/\[(?:本页自动识别不完整|自动识别不完整|无法可靠辨认)/u.test(row.body)))continue;
  if(!cached.some(row=>row.body.trim()))continue;
  const warnings=['旧 SQLite 整页缓存迁入；验证了原件哈希和物理页覆盖，未重新核验全文抽取准确性',
   '旧缓存公式、内联符号和上下标未核验，请核对原 PDF',...(document.error?[`旧缓存保留警告：${document.error}`]:[])];
  return {...result,decision:'eligible',reason:'Original hash and complete physical-page cache verified',candidate:{parser,
   parserVersion:`legacy-cache-${parser}-v1`,extractionMethod:`legacy-sqlite-page-cache:${parser}`,warnings,
   pages:cached.map(row=>({pageNumber:row.page+1,locator:`第 ${row.page+1} 页`,text:row.body}))}};
 }
 return result;
}

export async function applyLegacyPdfCache(document:LegacyPdfDocument,audit:LegacyPdfAudit){
 if(audit.documentId!==document.id||audit.ownerId!==document.owner_id||audit.sourceHash!==document.hash)throw new Error('Legacy cache audit identity mismatch');
 const current=(await kernelPool().query<{current_version_id:string|null;owner_id:string;source_hash:string;hidden:boolean}>(
  'SELECT current_version_id,owner_id,source_hash,hidden FROM document_texts WHERE id=$1',[document.id])).rows[0];
 if(current){
  if(current.hidden||current.owner_id!==document.owner_id||current.source_hash!==document.hash)return {action:'protected-current-head'};
  if(current.current_version_id){
   const pages=await kernel.parsedDocument(document.owner_id,document.id),candidate=audit.candidate;
   const warnings=[...new Set(candidate?.warnings.map(warning=>warning.trim()).filter(Boolean)||[])].sort();
   const same=candidate&&pages.length===candidate.pages.length&&pages.every((page,index)=>
    page.page_number===candidate.pages[index].pageNumber&&page.body===candidate.pages[index].text&&
    page.parser_version===candidate.parserVersion&&page.extraction_method===candidate.extractionMethod&&
    JSON.stringify(page.warnings)===JSON.stringify(warnings));
   return {action:same?'already-imported':'protected-current-head',versionId:current.current_version_id};
  }
 }
 if(!audit.candidate){
  if(!audit.originalPages||audit.originalPages>500)return {action:'blocked-invalid-original'};
  const jobId=await queueIngestionJob('docling_document',document.origin,document.course_id||'unscoped',
   {owner:document.owner_id,id:document.id,sourceHash:document.hash,formulaEnriched:false,formulaBackend:'ai',scanBackend:'docling'},
   `docling:${document.id}:${document.hash}:docling-v2-text-search`);
  return {action:'queued-text-parse',jobId};
 }
 const candidate=audit.candidate;
 await kernel.ingestParsedDocument({id:document.id,ownerId:document.owner_id,createdAt:document.created_at,
  courseId:document.course_id,name:document.name,hash:document.hash,mime:document.mime,origin:document.origin,originKey:document.origin_key},
  candidate.pages,{parserVersion:candidate.parserVersion,expectedPages:audit.originalPages!,warnings:candidate.warnings,
   extractionMethod:candidate.extractionMethod,expectedCurrentVersion:null});
 return {action:'imported',versionId:(await kernelPool().query('SELECT current_version_id FROM document_texts WHERE id=$1',[document.id])).rows[0].current_version_id};
}
