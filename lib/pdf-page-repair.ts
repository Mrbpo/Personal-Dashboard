import {PDFDocument} from 'pdf-lib';
import {createHash} from 'node:crypto';
import {digest,getDocument,readBlob} from './library.ts';
import {database} from './database.ts';
import {kernelPool} from './kernel/db.ts';
import {kernel} from './kernel/service.ts';
import {budgetStatus} from './ai-budget.ts';
import {serviceValue} from './service-vault.ts';
import {selectedVisualPageCacheParser,transcribePdfVisualPages,PDF_VISUAL_PAGES_PER_UTC_DAY,SELECTED_VISUAL_PARSER_VERSION} from './document-parser.ts';
import {assertVisualCacheStructure} from './pdf-visual-structure.ts';

export const PAGE_REPAIR_MODEL='gpt-5-mini';
export const PAGE_REPAIR_PARSER='pdf-selected-page-repair-v1';
export type PageRepairTarget={documentId:string;sourceHash:string;expectedVersion:string;pageNumbers:number[]};
export type PageRepairPlan={owner:string;documents:PageRepairTarget[]};
export type PageRepairResult={documentId:string;sourceHash:string;expectedVersion:string;model:string;parserVersion:string;
 pages:Array<{pageNumber:number;locator:string;text:string;textHash:string}>};

export function validatePageRepairPlan(plan:PageRepairPlan){
 if(!plan.owner||!Array.isArray(plan.documents)||!plan.documents.length||plan.documents.length>2||
  new Set(plan.documents.map(document=>document.documentId)).size!==plan.documents.length||
  plan.documents.some(document=>!document.documentId||! /^[a-f0-9]{64}$/.test(document.sourceHash)||! /^[a-f0-9]{64}$/.test(document.expectedVersion)||
   !Array.isArray(document.pageNumbers)||!document.pageNumbers.length||new Set(document.pageNumbers).size!==document.pageNumbers.length||
   document.pageNumbers.some(page=>!Number.isInteger(page)||page<1))||
  plan.documents.reduce((count,document)=>count+document.pageNumbers.length,0)>2)
  throw new Error('Repair plan requires exact original hashes/versions and at most two distinct selected pages');
}
export function pageRepairPlanHash(plan:PageRepairPlan){validatePageRepairPlan(plan);return digest(JSON.stringify(plan));}

export async function pageRepairEstimate(plan:PageRepairPlan){
 validatePageRepairPlan(plan);
 const configured=JSON.parse(serviceValue('AI_MODEL_RATES')||'{}')[PAGE_REPAIR_MODEL]||{input:.25,output:2,context:400000};
 if(![configured.input,configured.output,configured.context].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)||!configured.context)
  throw new Error('Invalid configured recognition rates');
 let maximumRequests=0;
 for(const target of plan.documents){
  const cacheParser=selectedVisualPageCacheParser(target.sourceHash,PAGE_REPAIR_MODEL,true);
  for(const page of target.pageNumbers){
   const cached=await database.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=?')
    .bind(target.documentId,cacheParser,page-1).first<{body:string}>();
   if(!cached?.body?.trim())maximumRequests++;
  }
 }
 const maximumReservationUsd=maximumRequests*(configured.context*configured.input+9000*configured.output)/1e6;
 const budget=await budgetStatus();
 const dayStart=Math.floor(Date.now()/86400000)*86400000;
 const daily=(await database.prepare('SELECT count(*) n FROM ai_ledger WHERE kind=? AND created_at>=? AND created_at<?')
  .bind('pdf-transcription',dayStart,dayStart+86400000).first<{n:number}>())?.n||0;
 return {model:PAGE_REPAIR_MODEL,maximumRequests,maxOutputTokensPerRequest:9000,configuredRates:configured,
  maximumReservationUsd,budget,availableUsd:Math.max(0,budget.limit-budget.used),remainingDailyRequests:Math.max(0,PDF_VISUAL_PAGES_PER_UTC_DAY-Number(daily))};
}

async function snapshot(owner:string,target:PageRepairTarget){
 const document=await getDocument(owner,target.documentId);
 const bytes=await readBlob(document.hash);
 if(document.mime!=='application/pdf'||document.hash!==target.sourceHash||digest(bytes)!==target.sourceHash)throw new Error('Repair original identity/hash mismatch');
 const originalCount=(await PDFDocument.load(bytes,{updateMetadata:false})).getPageCount();
 if(target.pageNumbers.some(page=>page>originalCount))throw new Error('Repair original page is out of range');
 const rows=(await kernelPool().query<{version_id:string;source_version_id:string;page_count:number;page_number:number;
  evidence_id:string;locator:string;body:string;parser_version:string;extraction_method:string;model?:string;warnings:string[]}>(`
  SELECT v.id version_id,v.source_version_id,v.page_count,v.warnings,p.page_number,p.evidence_id,p.locator,p.body,
   coalesce(e.parsed_value->'pageProvenance'->>'parserVersion',v.parser_version) parser_version,
   e.parsed_value->'pageProvenance'->>'model' model,
   coalesce(e.parsed_value->>'extractionMethod',s.raw_value->>'extractionMethod',v.parser_version) extraction_method
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
   JOIN document_text_pages p ON p.version_id=v.id JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
   JOIN source_item_versions s ON s.id=v.source_version_id
  WHERE d.id=$1 AND d.owner_id=$2 AND d.hidden=false AND d.source_hash=$3 ORDER BY p.page_number`,
 [target.documentId,owner,target.sourceHash])).rows;
 if(rows.length!==originalCount||rows.some((page,index)=>page.page_number!==index+1||page.page_count!==originalCount||page.version_id!==target.expectedVersion))
  throw new Error('Repair needs a complete unchanged current original version');
 return {document,bytes,rows,originalCount};
}

export async function recognizePageRepair(owner:string,target:PageRepairTarget):Promise<PageRepairResult>{
 const {bytes}=await snapshot(owner,target);
 const pages=await transcribePdfVisualPages(target.documentId,bytes,{pageNumbers:target.pageNumbers,expectedSourceHash:target.sourceHash,
  model:PAGE_REPAIR_MODEL,imageInput:true});
 return {documentId:target.documentId,sourceHash:target.sourceHash,expectedVersion:target.expectedVersion,model:PAGE_REPAIR_MODEL,parserVersion:SELECTED_VISUAL_PARSER_VERSION,
  pages:pages.map(page=>({...page,textHash:digest(page.text)}))};
}

export async function applyPageRepair(owner:string,target:PageRepairTarget,result:PageRepairResult){
 const {document,rows,originalCount}=await snapshot(owner,target);
 if(result.documentId!==target.documentId||result.sourceHash!==target.sourceHash||result.expectedVersion!==target.expectedVersion||result.model!==PAGE_REPAIR_MODEL||result.parserVersion!==SELECTED_VISUAL_PARSER_VERSION||
  !Array.isArray(result.pages)||result.pages.length!==target.pageNumbers.length||new Set(result.pages.map(page=>page.pageNumber)).size!==result.pages.length)
  throw new Error('Repair staged result identity mismatch');
 const replacement=new Map(result.pages.map(page=>[page.pageNumber,page]));
 const cacheParser=selectedVisualPageCacheParser(target.sourceHash,PAGE_REPAIR_MODEL,true);
 for(const pageNumber of target.pageNumbers){
  const page=replacement.get(pageNumber);
  if(!page||!page.text?.trim()||page.locator!==`第 ${pageNumber} 页`||page.textHash!==digest(page.text))throw new Error('Repair staged original page/hash mismatch');
  const cached=await database.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=?')
   .bind(target.documentId,cacheParser,pageNumber-1).first<{body:string}>();
  if(cached?.body!==page.text)throw new Error('Repair must use the validated recognition cache; hand-edited staged text is not accepted');
  assertVisualCacheStructure(page.text,pageNumber);
 }
 const pages=rows.map(page=>({pageNumber:page.page_number,locator:page.locator,text:replacement.get(page.page_number)?.text??page.body}));
 const pageProvenance=rows.map(page=>({pageNumber:page.page_number,
  extractionMethod:replacement.has(page.page_number)?'ai-visual-page-transcription':page.extraction_method,
  parserVersion:replacement.has(page.page_number)?SELECTED_VISUAL_PARSER_VERSION:page.parser_version,
  ...(replacement.has(page.page_number)?{model:PAGE_REPAIR_MODEL}:page.model?{model:page.model}:{}),
  basedOn:{versionId:page.version_id,sourceVersionId:page.source_version_id,evidenceId:page.evidence_id}}));
 const warnings=[...new Set([...(rows[0].warnings||[]),`仅原始第 ${target.pageNumbers.join('、')} 页经过 AI 整页转写；其余页保留原解析方法`,
  ...result.pages.filter(page=>page.text.includes('[无法可靠辨认')).map(page=>`第 ${page.pageNumber} 页保留无法可靠辨认标记，请核对原 PDF`)])];
 await kernel.ingestParsedDocument({id:document.id,ownerId:owner,courseId:document.course_id,name:document.name,hash:document.hash,
  mime:document.mime,origin:document.origin,originKey:document.origin_key,createdAt:document.created_at},pages,
 {parserVersion:PAGE_REPAIR_PARSER,expectedPages:originalCount,expectedCurrentVersion:target.expectedVersion,
  extractionMethod:'mixed-original-page-repair',pageProvenance,warnings});
 const head=(await kernelPool().query<{current_version_id:string}>('SELECT current_version_id FROM document_texts WHERE id=$1 AND owner_id=$2',[document.id,owner])).rows[0];
 return {documentId:document.id,previousVersion:target.expectedVersion,currentVersion:head.current_version_id,pageCount:originalCount,
  repairedPages:target.pageNumbers,pageProvenance,textHash:createHash('sha256').update(JSON.stringify(pages)).digest('hex')};
}

export async function verifyAppliedPageRepair(owner:string,target:PageRepairTarget,result:PageRepairResult,applied:Awaited<ReturnType<typeof applyPageRepair>>){
 const document=await getDocument(owner,target.documentId),bytes=await readBlob(document.hash);
 if(result.documentId!==target.documentId||result.sourceHash!==target.sourceHash||result.expectedVersion!==target.expectedVersion||result.model!==PAGE_REPAIR_MODEL||result.parserVersion!==SELECTED_VISUAL_PARSER_VERSION||
  applied.documentId!==target.documentId||applied.previousVersion!==target.expectedVersion||
  JSON.stringify(applied.repairedPages)!==JSON.stringify(target.pageNumbers)||document.hash!==target.sourceHash||digest(bytes)!==target.sourceHash)
  throw new Error('Recorded completed repair identity mismatch');
 const count=(await PDFDocument.load(bytes,{updateMetadata:false})).getPageCount();
 const current=(await kernelPool().query<{page_number:number;locator:string;body:string}>(`
  SELECT p.page_number,p.locator,p.body FROM document_texts d JOIN document_text_pages p ON p.version_id=d.current_version_id
  WHERE d.id=$1 AND d.owner_id=$2 AND d.source_hash=$3 AND d.current_version_id=$4 AND d.hidden=false ORDER BY p.page_number`,
 [target.documentId,owner,target.sourceHash,applied.currentVersion])).rows;
 const pages=current.map(page=>({pageNumber:page.page_number,locator:page.locator,text:page.body}));
 if(current.length!==count||applied.pageCount!==count||current.some((page,index)=>page.page_number!==index+1)||
  digest(JSON.stringify(pages))!==applied.textHash||result.pages.some(page=>current[page.pageNumber-1]?.body!==page.text||digest(page.text)!==page.textHash))
  throw new Error('Recorded repair is not the complete exact current version; cannot skip it');
 return true;
}
