import type {Pool} from 'pg';
import type {DocumentContextSource} from './document-context.ts';
import {readFullDocumentEvidence,DocumentEvidenceChangedError,type DocumentSelectedNodeHit} from './document-evidence.ts';

export class DocumentNodeSelectionError extends Error{
 readonly code='DOCUMENT_NODE_SELECTION_INVALID';
 constructor(){super('Select 1 to 14 distinct current evidence IDs with a complete expected source');this.name='DocumentNodeSelectionError';}
}
const bounded=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4000;
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
