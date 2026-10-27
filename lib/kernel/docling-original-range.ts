import {PDFDocument} from 'pdf-lib';
import {digest,readBlob,saveBlob} from '../library.ts';
import {kernelPool} from './db.ts';
import {kernel} from './service.ts';
import {storeDoclingResult} from './docling-batches.ts';
import {decodeDoclingResult,indexDoclingPageRegions,validateOriginalDoclingPageRange,type DoclingVisualLayout} from './docling-result.ts';
import {doclingPageResultReferences} from './docling-source-regions.ts';
import {preparePdfVisualEvidence,readPdfVisualEvidence} from './pdf-visual-evidence.ts';

export const ORIGINAL_DOCLING_RANGE_VERSION='docling-original-page-range-v1';
export type CachedOriginalDoclingRenderer=Parameters<typeof preparePdfVisualEvidence>[1];
export type OriginalDoclingRangeInput={owner:string;documentId:string;sourceHash:string;expectedCurrentVersion:string;
 rawExportSha256:string;pageRange:[number,number];producer:{imageDigest:string;packages:Record<string,string>;
 configuration:Record<string,unknown>;conversionStatus:'success'|'unknown'}};
const hex=(s:string)=>/^[a-f0-9]{64}$/.test(s);

/** A validated adapter projection, not a fabricated producer response. The
 * immutable export, producer status and original-input page numbers survive. */
export async function stageOriginalDoclingRange(input:OriginalDoclingRangeInput,original:Uint8Array){
 input=structuredClone(input);
 original=Buffer.from(original);
 if([input.owner,input.documentId].some(s=>typeof s!=='string'||!s||s.length>200||s.includes('\0'))||
  !Array.isArray(input.pageRange)||!input.producer||typeof input.producer!=='object'||
  !input.producer.packages||typeof input.producer.packages!=='object'||Array.isArray(input.producer.packages)||
  !input.producer.configuration||typeof input.producer.configuration!=='object'||Array.isArray(input.producer.configuration)||
  !hex(input.sourceHash)||!hex(input.expectedCurrentVersion)||!hex(input.rawExportSha256)||
  digest(original)!==input.sourceHash||!/^sha256:[a-f0-9]{64}$/.test(input.producer.imageDigest)||
  !['success','unknown'].includes(input.producer.conversionStatus)||Buffer.byteLength(JSON.stringify(input.producer))>16384||
  !Object.keys(input.producer.packages).length||Object.entries(input.producer.packages).some(([k,v])=>!k||typeof v!=='string'||!v||k.length>100||v.length>100))
  throw Error('Invalid cached original Docling range identity/producer');
 const totalPages=(await PDFDocument.load(original,{updateMetadata:false})).getPageCount(),copyIndices=Array.from({length:totalPages},(_,i)=>i),
  range=validateOriginalDoclingPageRange(input.pageRange,{sourceHash:input.sourceHash,inputHash:input.sourceHash,pageCount:totalPages,copyIndices})!;
 const bytes=await readBlob(input.rawExportSha256);
 if(bytes.length>16*1024*1024||digest(bytes)!==input.rawExportSha256)throw Error('Original Docling export checksum/size differs');
 const originIntegers=new WeakMap<object,string>(),parse=JSON.parse as (text:string,reviver:(this:object,key:string,value:unknown,
  context?:{source?:string})=>unknown)=>Record<string,unknown>;
 const document=parse(Buffer.from(bytes).toString('utf8'),function(key,value,context){
  if(key==='binary_hash'&&typeof value==='number'&&context?.source)originIntegers.set(this,context.source);
  return value;
 });
 const origin=document.origin as {mimetype?:string;binary_hash?:unknown}|undefined;
 // Docling Core masks a SHA256 origin hash to uint64. Preserve the integer
 // lexeme: ordinary JSON numbers cannot represent every 64-bit hash exactly.
 const rawOrigin=origin&&(typeof origin.binary_hash==='string'?origin.binary_hash:originIntegers.get(origin));
 if(origin?.mimetype!=='application/pdf'||!rawOrigin||
  !(/^[a-f0-9]{64}$/i.test(rawOrigin)?BigInt('0x'+rawOrigin)===(BigInt('0x'+input.sourceHash)):
   /^\d+$/.test(rawOrigin)&&BigInt(rawOrigin)===(BigInt('0x'+input.sourceHash)&BigInt('0xffffffffffffffff'))))
  throw Error('Cached Docling export origin does not match the original PDF');
 const result={status:'success',errors:[],document:{json_content:document}},
  decoded=decodeDoclingResult(result,totalPages,{pageRange:range,formulaEnriched:false});
 // Validate all declared references and boxes as well as the text decoder.
 for(let page=range[0];page<=range[1];page++)indexDoclingPageRegions(result,page,totalPages,range);
 const producer={...input.producer,rawExportSha256:input.rawExportSha256,normalization:ORIGINAL_DOCLING_RANGE_VERSION,
  statusMeaning:'adapter-schema-and-page-coverage-valid',sourceFaithfulnessVerified:false,semanticRelationsVerified:false},
  optionsHash=digest(JSON.stringify({producer,sourceHash:input.sourceHash,resultPageRange:range})),
  identity={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,totalPages,inputHash:input.sourceHash,
   copyIndices,optionsHash,resultPageRange:range},
  resultBlobSha256=await storeDoclingResult({identity,producer,result}),
  reference={resultBlobSha256,derivedInputSha256:input.sourceHash,copyIndices,optionsHash,resultPageRange:range};
 const resultBytes=await readBlob(resultBlobSha256);
 return {decoded,reference,producer,totalPages,batchProvenance:{kind:ORIGINAL_DOCLING_RANGE_VERSION,
  source:{owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash},producer,
  blobReferences:[{kind:'docling-original-export',sha256:input.rawExportSha256,byteLength:bytes.length},
   {kind:'docling-original-range-envelope',sha256:resultBlobSha256,byteLength:resultBytes.length}]}};
}

type Current={id:string;owner_id:string;course_id:string|null;name:string;source_hash:string;origin:string;origin_key:string;created_at:Date;
 current_version_id:string;source_version_id:string;page_count:number;warnings:string[];raw_sha256:string;raw_value:{batchProvenance?:unknown}};
type Page={page_number:number;locator:string;body:string;evidence_id:string;parser_version:string;extraction_method:string;model:string|null};
/** Cached observation -> ordinary Kernel ingestion. No parsing/model/network
 * call, direct fact update or mutation of a published page/version is possible. */
export async function ingestCachedOriginalDoclingRange(input:OriginalDoclingRangeInput,
 renderer?:CachedOriginalDoclingRenderer){
 input=structuredClone(input);
 const db=kernelPool(),d=(await db.query<Current>(`SELECT d.*,v.source_version_id,v.page_count,v.warnings,s.raw_sha256,s.raw_value
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
  WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.hidden`,[input.owner,input.documentId])).rows[0];
 if(!d||d.current_version_id!==input.expectedCurrentVersion||d.source_hash!==input.sourceHash||d.raw_sha256!==input.sourceHash)
  throw Error('Original Docling range source is no longer current');
 const old=(await db.query<Page>(`SELECT p.page_number,p.locator,p.body,p.evidence_id,
  coalesce(e.parsed_value->'pageProvenance'->>'parserVersion',v.parser_version) parser_version,
  e.parsed_value->'pageProvenance'->>'model' model,
  coalesce(e.parsed_value->>'extractionMethod',s.raw_value->>'extractionMethod',v.parser_version) extraction_method
  FROM document_text_pages p JOIN document_text_versions v ON v.id=p.version_id JOIN source_item_versions s ON s.id=v.source_version_id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
  WHERE p.version_id=$1 AND v.document_id=$2 ORDER BY p.page_number`,[d.current_version_id,d.id])).rows;
 if(old.length!==d.page_count||old.some((p,i)=>p.page_number!==i+1))throw Error('Original Docling range needs the complete previous source');
 const prior=d.raw_value.batchProvenance as Record<string,unknown>|undefined;
 if(old.some(p=>p.extraction_method!=='native-text')||prior?.sourceMath||prior?.sourceEncoding||
  (prior?.identity as Record<string,unknown>|undefined)?.sourceEncodingReceiptHash)
  throw Error('Original Docling range cannot replace an already enhanced or mixed parsing version');
 const original=await readBlob(input.sourceHash),staged=await stageOriginalDoclingRange(input,original),range=input.pageRange,
  selected=(n:number)=>n>=range[0]&&n<=range[1];
 if(staged.totalPages!==d.page_count||old.some(p=>selected(p.page_number)&&p.extraction_method!=='native-text'))
  throw Error('Original Docling range can only enrich explicitly selected native-text pages');
 const source={documentId:d.id,currentVersionId:d.current_version_id,sourceVersionId:d.source_version_id,sourceHash:d.source_hash,courseId:d.course_id??''},
  previous=await readPdfVisualEvidence(db,input.owner,source,[]),layout=previous.layout??{status:'unavailable' as const,regions:[],pageSizes:[]};
 for(let page=range[0];page<=range[1];page++)if(doclingPageResultReferences({owner:input.owner,documentId:d.id,sourceHash:d.source_hash,
  pageCount:d.page_count,physicalPage:page},d.raw_value.batchProvenance,layout).length)throw Error('Selected native page already has a registered structured result');
 const enriched:DoclingVisualLayout={...layout,status:'unavailable',reason:'Partial original-page-range enrichment; full layout and semantic relations remain unverified',
  regions:[...layout.regions.filter(r=>!selected(r.pageNumber)),...staged.decoded.visualLayout.regions.map(r=>({...r,
   resultBlobSha256:staged.reference.resultBlobSha256,derivedInputSha256:input.sourceHash,copyIndices:staged.reference.copyIndices}))],
  pageSizes:[...layout.pageSizes.filter(p=>!selected(p.pageNumber)),...staged.decoded.visualLayout.pageSizes].sort((a,b)=>a.pageNumber-b.pageNumber),
  resultReferences:[...layout.resultReferences??[],staged.reference]};
 const pdfVisuals=await preparePdfVisualEvidence({owner:input.owner,documentId:d.id,sourceHash:d.source_hash,pdfBytes:original,layout:enriched},renderer);
 if(pdfVisuals.content.renderStatus!=='available')throw Error('Original Docling range retains the previous version when original images are unavailable');
 const changed=new Map(staged.decoded.pages.map(p=>[p.pageNumber,p])),pages=old.map(p=>changed.get(p.page_number)??{pageNumber:p.page_number,locator:p.locator,text:p.body}),
  pageProvenance=old.map(p=>({pageNumber:p.page_number,parserVersion:selected(p.page_number)?ORIGINAL_DOCLING_RANGE_VERSION:p.parser_version,
   extractionMethod:selected(p.page_number)?'cached-docling-original-range':p.extraction_method,...(!selected(p.page_number)&&p.model?{model:p.model}:{}),
   basedOn:{versionId:d.current_version_id,sourceVersionId:d.source_version_id,evidenceId:p.evidence_id}}));
 // Preserve prior metadata; historical versions remain independent GC roots.
 const previousReceipt=Buffer.from(JSON.stringify(d.raw_value.batchProvenance??null)),previousReceiptSha256=await saveBlob(previousReceipt),
  batchProvenance={...staged.batchProvenance,previousParsingProvenance:{sha256:previousReceiptSha256},
   blobReferences:[...staged.batchProvenance.blobReferences,{kind:'previous-parsing-provenance',sha256:previousReceiptSha256,byteLength:previousReceipt.length}]};
 await kernel.ingestParsedDocument({id:d.id,ownerId:input.owner,courseId:d.course_id??'',name:d.name,hash:d.source_hash,
  mime:'application/pdf',origin:d.origin,originKey:d.origin_key,createdAt:d.created_at.toISOString()},pages,
  {parserVersion:ORIGINAL_DOCLING_RANGE_VERSION,extractionMethod:'mixed-cached-docling-original-range',expectedPages:d.page_count,
   expectedCurrentVersion:d.current_version_id,pageProvenance,batchProvenance,pdfVisuals,
   warnings:[...new Set([...d.warnings,...staged.decoded.warnings,`Only original pages ${range[0]}-${range[1]} enriched from cached Docling export; other pages retain prior parsing. Producer status ${input.producer.conversionStatus}; faithfulness/semantics unverified.`])]});
 const current=(await db.query<{current_version_id:string}>('SELECT current_version_id FROM document_texts WHERE owner_id=$1 AND id=$2',[input.owner,d.id])).rows[0];
 return {previousVersion:d.current_version_id,currentVersion:current.current_version_id,range:staged.reference.resultPageRange,
  resultBlobSha256:staged.reference.resultBlobSha256,originalHash:d.source_hash,unchangedPages:old.filter(p=>!selected(p.page_number)).length};
}
