import type {Pool} from 'pg';
import type {DocumentTextHit} from './document-search.ts';

/** A planner's explicit current-node selection is not a relevance ranking. */
export type DocumentSelectedNodeHit=Omit<DocumentTextHit,'score'|'retrieval_mode'|'lexical_support'|'degraded_reason'|
 'rerank_model'|'rerank_reasoning_effort'|'rerank_max_output_tokens'|'retrieval_scope'|'evidence_body'>&{
 reader_selection:'evidence-node-ids';retrieval_mode:'reader-selection';evidence_body:'full-page';score?:never};
export type DocumentEvidenceHit=DocumentTextHit|DocumentSelectedNodeHit;

export class DocumentEvidenceChangedError extends Error {
 readonly code='DOCUMENT_EVIDENCE_CHANGED';
 constructor(){super('Retrieved document evidence is no longer current');this.name='DocumentEvidenceChangedError';}
}

/** Read the stored page after ranking. A snippet is never used as its substitute.
 * The same statement checks current owner, visibility, origin and source version.
 * Full-page describes stored text; parser warnings still qualify its fidelity.
 */
export async function readFullDocumentEvidence<Hit extends DocumentEvidenceHit>(pool:Pool,owner:string,hits:Hit[]):Promise<Hit[]> {
 if(!hits.length)return hits;
 const requested=hits.map((hit,ordinal)=>({ordinal,document_id:hit.document_id,page_number:hit.page_number,
  evidence_id:hit.evidence_id,source_version_id:hit.source_version_id,source_hash:hit.source_hash,
  course_id:hit.course_id,parser_version:hit.parser_version,name:hit.name,origin:hit.origin,origin_key:hit.origin_key}));
 const result=await pool.query<{ordinal:number;version_id:string;body:string;parser_warnings:string[]}>(`
  WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(ordinal integer,
   document_id text,page_number integer,evidence_id text,source_version_id text,
   source_hash text,course_id text,parser_version text,name text,origin text,origin_key text))
  SELECT r.ordinal,v.id version_id,p.body,v.warnings parser_warnings
  FROM requested r JOIN document_texts d ON d.id=r.document_id AND d.owner_id=$1
   AND d.hidden=false AND d.source_hash=r.source_hash AND coalesce(d.course_id,'')=r.course_id
   AND d.name=r.name AND d.origin=r.origin AND d.origin_key=r.origin_key
  JOIN document_text_versions v ON v.id=d.current_version_id
   AND v.source_version_id=r.source_version_id AND v.parser_version=r.parser_version
  JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=r.page_number AND p.evidence_id=r.evidence_id
  WHERE NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
   AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
   AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY r.ordinal`,[owner,JSON.stringify(requested)]);
 if(result.rows.length!==hits.length||result.rows.some((row,index)=>row.ordinal!==index))
  throw new DocumentEvidenceChangedError();
 return result.rows.map((row,index)=>({...hits[index],id:`pg:${row.version_id}:${hits[index].page_number}`,
  body:row.body,parser_warnings:row.parser_warnings,evidence_body:'full-page'}));
}
