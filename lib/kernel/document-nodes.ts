import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import type {DocumentContextSource} from './document-context.ts';
import {readFullDocumentEvidence,DocumentEvidenceChangedError,type DocumentSelectedNodeHit} from './document-evidence.ts';

export class DocumentNodeSelectionError extends Error{
 readonly code='DOCUMENT_NODE_SELECTION_INVALID';
 constructor(){super('Select 1 to 14 distinct current evidence IDs with a complete expected source');this.name='DocumentNodeSelectionError';}
}
const bounded=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4000;

export type DocumentCitationSource={documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string};
export class DocumentCitationUnavailableError extends Error{
 readonly code='DOCUMENT_CITATION_UNAVAILABLE';
 constructor(){super('The exact owned citation snapshot is unavailable');this.name='DocumentCitationUnavailableError';}
}
/** An archived citation is readable evidence, not an input selection for current
 * generation. Keep this DTO distinct from DocumentSelectedNodeHit. One SQL
 * snapshot checks current access while reading the exact immutable version. */
export async function readDocumentCitationSnapshot(pool:Pool,owner:string,expected:DocumentCitationSource,evidenceIds:string[]){
 const source={...expected},ids=Array.isArray(evidenceIds)?[...evidenceIds]:[];
 if(!bounded(owner)||![source.documentId,source.documentVersionId,source.sourceVersionId,source.sourceHash].every(bounded)||
  ids.length<1||ids.length>14||ids.some(id=>!bounded(id))||new Set(ids).size!==ids.length)
  throw new Error('Invalid citation snapshot reference');
 const rows=(await pool.query<{current_version_id:string|null;superseded:boolean;source_name:string|null;
  parser_version:string;parser_warnings:string[];page_count:number;evidence_id:string;page_number:number;locator:string;body:string;read_at:string}>(`
  SELECT d.current_version_id,EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id))) superseded,
   s.raw_value->>'name' source_name,v.parser_version,v.warnings parser_warnings,v.page_count,
   p.evidence_id,p.page_number,p.locator,p.body,statement_timestamp()::text read_at
  FROM document_texts d JOIN document_text_versions v ON v.document_id=d.id AND v.id=$3
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id AND s.raw_sha256=$5
  JOIN document_text_pages p ON p.version_id=v.id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id AND e.source_item_id=d.source_item_id
  WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.hidden AND d.source_hash=$5
   AND v.source_version_id=$4 AND p.evidence_id=ANY($6::text[])`,
 [owner,source.documentId,source.documentVersionId,source.sourceVersionId,source.sourceHash,ids])).rows;
 const byId=new Map(rows.map(row=>[row.evidence_id,row]));
 if(rows.length!==ids.length||byId.size!==ids.length||ids.some(id=>!byId.has(id)))throw new DocumentCitationUnavailableError();
 const first=rows[0];
 return {source,status:first.current_version_id===source.documentVersionId&&!first.superseded?'current' as const:'historical' as const,
  currentDocumentVersionId:first.current_version_id,originSuperseded:first.superseded,sourceName:first.source_name,
  parserVersion:first.parser_version,parserWarnings:first.parser_warnings,pageCount:first.page_count,readAt:first.read_at,
  authority:'stored-parsed-source-evidence' as const,usableForCurrentGeneration:false as const,
  nodes:ids.map(id=>{const row=byId.get(id)!;return {evidenceId:id,physicalPage:row.page_number,locator:row.locator,body:row.body,
   bodySha256:createHash('sha256').update(row.body).digest('hex')};})};
}
/** Read original nodes selected by ID, without scores, search or model calls. */
export async function readDocumentNodes(pool:Pool,owner:string,expected:DocumentContextSource,
 evidenceIds:string[]):Promise<DocumentSelectedNodeHit[]>{
 const source={...expected},ids=Array.isArray(evidenceIds)?[...evidenceIds]:[];
 if(!bounded(owner)||![source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash].every(bounded)||
  (source.courseId!==undefined&&typeof source.courseId!=='string')||ids.length<1||ids.length>14||
  ids.some(id=>!bounded(id))||new Set(ids).size!==ids.length)
  throw new DocumentNodeSelectionError();
 const rows=(await pool.query<Omit<DocumentSelectedNodeHit,'reader_selection'|'retrieval_mode'|'evidence_body'>>(`
  SELECT 'pg:'||v.id||':'||p.page_number id,d.id document_id,coalesce(d.course_id,'') course_id,d.name,d.origin,d.origin_key,
   d.source_hash,''::text body,p.locator,p.page_number,p.evidence_id,v.source_version_id,v.parser_version,
   v.warnings parser_warnings,p.content_kind,p.start_ms::double precision start_ms,p.end_ms::double precision end_ms
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
  JOIN document_text_pages p ON p.version_id=v.id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id AND e.source_item_id=d.source_item_id
  WHERE d.owner_id=$1 AND d.id=$2 AND d.current_version_id=$3 AND v.source_version_id=$4 AND d.source_hash=$5
   AND NOT d.hidden AND ($6::text IS NULL OR coalesce(d.course_id,'')=$6) AND p.evidence_id=ANY($7::text[])
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin
    AND newer.origin_key=d.origin_key AND NOT newer.hidden AND (newer.created_at>d.created_at
     OR (newer.created_at=d.created_at AND newer.id>d.id)))`,
 [owner,source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash,source.courseId??null,ids])).rows;
 if(rows.length!==ids.length)throw new DocumentEvidenceChangedError();
 const byId=new Map(rows.map(row=>[row.evidence_id,row]));
 if(byId.size!==rows.length||ids.some(id=>!byId.has(id)))throw new DocumentEvidenceChangedError();
 const selected:DocumentSelectedNodeHit[]=ids.map(id=>({...byId.get(id)!,reader_selection:'evidence-node-ids',
  retrieval_mode:'reader-selection',evidence_body:'full-page'}));
 const full=await readFullDocumentEvidence(pool,owner,selected);
 if(full.some(hit=>hit.id!==`pg:${source.currentVersionId}:${hit.page_number}`||hit.source_version_id!==source.sourceVersionId||
  hit.source_hash!==source.sourceHash))throw new DocumentEvidenceChangedError();
 return full;
}
