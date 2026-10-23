import {PDFDocument} from 'pdf-lib';
import {readBlob,saveBlob,digest} from '../library.ts';
import {kernelPool} from './db.ts';
import {kernel} from './service.ts';
import {preparePdfVisualEvidence,readPdfVisualEvidence} from './pdf-visual-evidence.ts';
import {NATIVE_REGION_TEXT_VERSION,NATIVE_REGION_LIMITS,validateNativeRegionBundle,projectNativeRegionText} from './native-region-text.ts';

export type NativeRegionIngestionInput={owner:string;documentId:string;sourceHash:string;expectedCurrentVersion:string;observationSha256:string};
export type NativeRegionRenderer=Parameters<typeof preparePdfVisualEvidence>[1];
type Current={id:string;owner_id:string;course_id:string|null;name:string;source_hash:string;origin:string;origin_key:string;created_at:Date;
 current_version_id:string;source_version_id:string;page_count:number;warnings:string[];raw_sha256:string;raw_value:{mime:string;batchProvenance?:Record<string,unknown>}};
type Page={page_number:number;locator:string;body:string;evidence_id:string;parser_version:string;extraction_method:string;model:string|null};

/** Administrator observation import through ordinary Kernel ingestion. Previous
 * bodies remain literal prefixes; no published row, PDF or Docling JSON edits. */
export async function ingestNativeRegionText(input:NativeRegionIngestionInput,renderer?:NativeRegionRenderer){
 input=structuredClone(input);const db=kernelPool();
 const d=(await db.query<Current>(`SELECT d.*,v.source_version_id,v.page_count,v.warnings,s.raw_sha256,s.raw_value
 FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
 JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
 WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.hidden`,[input.owner,input.documentId])).rows[0];
 if(!d||d.current_version_id!==input.expectedCurrentVersion||d.source_hash!==input.sourceHash||d.raw_sha256!==input.sourceHash||d.raw_value.mime!=='application/pdf')throw Error('Native region source is no longer current');
 const old=(await db.query<Page>(`SELECT p.page_number,p.locator,p.body,p.evidence_id,
 coalesce(e.parsed_value->'pageProvenance'->>'parserVersion',v.parser_version) parser_version,
 e.parsed_value->'pageProvenance'->>'model' model,
 coalesce(e.parsed_value->>'extractionMethod',s.raw_value->>'extractionMethod',v.parser_version) extraction_method
 FROM document_text_pages p JOIN document_text_versions v ON v.id=p.version_id JOIN source_item_versions s ON s.id=v.source_version_id
 JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id AND e.source_item_id=s.source_item_id
 WHERE p.version_id=$1 AND v.document_id=$2 ORDER BY p.page_number`,[d.current_version_id,d.id])).rows;
 const prior=d.raw_value.batchProvenance;
 if(old.length!==d.page_count||old.some((p,i)=>p.page_number!==i+1||p.extraction_method!=='native-text')||prior?.sourceMath||prior?.sourceEncoding||prior?.nativeRegionText||
  (prior?.identity as Record<string,unknown>|undefined)?.sourceEncodingReceiptHash)
  throw Error('Native region import requires a complete unenhanced native baseline');
 const original=await readBlob(input.sourceHash),bytes=await readBlob(input.observationSha256);
 if(digest(original)!==input.sourceHash||bytes.length>NATIVE_REGION_LIMITS.bytes||digest(bytes)!==input.observationSha256)throw Error('Native region input checksum/size differs');
 const bundle=validateNativeRegionBundle(JSON.parse(Buffer.from(bytes).toString('utf8')),{owner:input.owner,documentId:d.id,sourceHash:d.source_hash,pageCount:d.page_count});
 const pdf=await PDFDocument.load(original,{updateMetadata:false});if(pdf.getPageCount()!==d.page_count)throw Error('Native region page count differs');
 for(const p of bundle.pages){const frame=pdf.getPages()[p.physicalPage-1],box=frame.getCropBox();
  if(frame.getRotation().angle!==0||box.x!==0||box.y!==0||Math.abs(box.width-p.width)>.001||Math.abs(box.height-p.height)>.001)throw Error('Native region original page frame differs');}
 const bounds=await readBlob(bundle.producer.boundsExportSha256);
 if(bounds.length>NATIVE_REGION_LIMITS.bytes||digest(bounds)!==bundle.producer.boundsExportSha256)throw Error('Native region bounding observation differs');
 const projected=projectNativeRegionText(bundle,old.map(p=>({pageNumber:p.page_number,locator:p.locator,text:p.body})),input.observationSha256),
  manifestBytes=Buffer.from(JSON.stringify(projected.manifest)),manifestSha256=await saveBlob(manifestBytes),
  previousBytes=Buffer.from(JSON.stringify(prior??null)),previousSha256=await saveBlob(previousBytes),
  source={documentId:d.id,currentVersionId:d.current_version_id,sourceVersionId:d.source_version_id,sourceHash:d.source_hash,courseId:d.course_id??''},
  visual=await readPdfVisualEvidence(db,input.owner,source,[]),
  pdfVisuals=await preparePdfVisualEvidence({owner:input.owner,documentId:d.id,sourceHash:d.source_hash,pdfBytes:original,
   layout:visual.layout??{status:'unavailable',regions:[],pageSizes:[]}},renderer);
 if(pdfVisuals.content.renderStatus!=='available')throw Error('Native region import retains old version when original images are unavailable');
 const changed=new Set(bundle.pages.map(p=>p.physicalPage));
 await kernel.ingestParsedDocument({id:d.id,ownerId:input.owner,courseId:d.course_id??'',name:d.name,hash:d.source_hash,mime:'application/pdf',origin:d.origin,originKey:d.origin_key,createdAt:d.created_at.toISOString()},projected.pages,
  {parserVersion:NATIVE_REGION_TEXT_VERSION,extractionMethod:'native-text-with-region-observations',expectedPages:d.page_count,expectedCurrentVersion:d.current_version_id,
   pageProvenance:old.map(p=>({pageNumber:p.page_number,parserVersion:changed.has(p.page_number)?NATIVE_REGION_TEXT_VERSION:p.parser_version,
    extractionMethod:changed.has(p.page_number)?'native-region-observations':p.extraction_method,...(!changed.has(p.page_number)&&p.model?{model:p.model}:{}),
    basedOn:{versionId:d.current_version_id,sourceVersionId:d.source_version_id,evidenceId:p.evidence_id}})),
   pdfVisuals,warnings:[...d.warnings,'Original native page text retained with supplemental region observations; row/column relationships, Unicode faithfulness and reading order remain unverified.'],
   batchProvenance:{nativeRegionText:{policy:NATIVE_REGION_TEXT_VERSION,manifestSha256,observationSha256:input.observationSha256},previousParsingProvenance:{sha256:previousSha256},
    blobReferences:[{kind:'native-region-observation',sha256:input.observationSha256,byteLength:bytes.length},
     {kind:'native-region-projection',sha256:manifestSha256,byteLength:manifestBytes.length},
     {kind:'native-region-bounds-candidate',sha256:bundle.producer.boundsExportSha256,byteLength:bounds.length},
     {kind:'previous-parsing-provenance',sha256:previousSha256,byteLength:previousBytes.length}]}});
 const current=(await db.query<{current_version_id:string}>('SELECT current_version_id FROM document_texts WHERE owner_id=$1 AND id=$2',[input.owner,d.id])).rows[0];
 return {previousVersion:d.current_version_id,currentVersion:current.current_version_id,manifestSha256,observationSha256:input.observationSha256,
  changedPages:[...changed],regions:bundle.pages.reduce((n,p)=>n+p.regions.length,0),newParserCalls:0};
}
