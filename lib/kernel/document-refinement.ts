import type {Pool} from 'pg';
import type {DocumentTextHit} from './document-search.ts';
import {readFullDocumentEvidence,DocumentEvidenceChangedError} from './document-evidence.ts';
import {selectAdjacentDocumentPagesWithAI} from './document-rerank.ts';

const key=(hit:DocumentTextHit)=>JSON.stringify([hit.document_id,hit.page_number]);

/** Expand only actual first-stage selections, not the original modality heads.
 * All neighbors are same-version stored PDF pages. No embedding or model call. */
export async function selectedDocumentNeighborhood(pool:Pool,owner:string,selected:DocumentTextHit[]):Promise<DocumentTextHit[]>{
 if(!owner||selected.length>5||new Set(selected.map(key)).size!==selected.length)
  throw new Error('Invalid selected PDF neighborhood');
 if(!selected.length)return [];
 const anchors=await readFullDocumentEvidence(pool,owner,selected);
 const rows=(await pool.query<DocumentTextHit&{anchor_number:number}>(`/* refinement:adjacent-evidence */
  WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(anchor_number integer,
   document_id text,page_number integer,id text,evidence_id text,source_version_id text,source_hash text,
   course_id text,name text,origin text,origin_key text,parser_version text))
  SELECT 'pg:'||v.id||':'||p.page_number id,d.id document_id,coalesce(d.course_id,'') course_id,
   d.name,d.origin,d.origin_key,d.source_hash,p.body,p.locator,p.page_number,p.content_kind,
   p.start_ms::double precision,p.end_ms::double precision,p.evidence_id,v.source_version_id,
   v.parser_version,v.warnings parser_warnings,0::double precision score,r.anchor_number
  FROM requested r JOIN document_texts d ON d.id=r.document_id AND d.owner_id=$1 AND NOT d.hidden
   AND d.source_hash=r.source_hash AND coalesce(d.course_id,'')=r.course_id
   AND d.name=r.name AND d.origin=r.origin AND d.origin_key=r.origin_key
  JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
   AND v.source_version_id=r.source_version_id AND v.parser_version=r.parser_version
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
   AND s.raw_sha256=d.source_hash AND s.raw_value->>'mime'='application/pdf'
  JOIN document_text_pages anchor ON anchor.version_id=v.id AND anchor.page_number=r.page_number
   AND anchor.evidence_id=r.evidence_id AND anchor.content_kind='page' AND 'pg:'||v.id||':'||anchor.page_number=r.id
  JOIN document_text_pages p ON p.version_id=v.id AND p.page_number IN (r.page_number-1,r.page_number+1)
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id AND e.source_item_id=d.source_item_id
  WHERE p.page_number BETWEEN 1 AND v.page_count AND p.content_kind='page' AND btrim(p.body)<>''
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
    AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY r.anchor_number,p.page_number`,[owner,JSON.stringify(anchors.map((hit,anchor_number)=>({anchor_number,
   document_id:hit.document_id,page_number:hit.page_number,id:hit.id,evidence_id:hit.evidence_id,
   source_version_id:hit.source_version_id,source_hash:hit.source_hash,course_id:hit.course_id,name:hit.name,
   origin:hit.origin,origin_key:hit.origin_key,parser_version:hit.parser_version})))])).rows;
 const candidates=new Map(selected.map(hit=>[key(hit),hit]));
 for(const {anchor_number,...hit} of rows){
  const anchor=anchors[anchor_number];
  if(!anchor||hit.document_id!==anchor.document_id||hit.source_version_id!==anchor.source_version_id||
   hit.source_hash!==anchor.source_hash||hit.course_id!==anchor.course_id||hit.name!==anchor.name||
   hit.origin!==anchor.origin||hit.origin_key!==anchor.origin_key||hit.parser_version!==anchor.parser_version||
   Math.abs(hit.page_number-anchor.page_number)!==1||!hit.evidence_id||!hit.body.trim())
   throw new DocumentEvidenceChangedError();
  const previous=candidates.get(key(hit));
  if(previous&&(previous.source_version_id!==hit.source_version_id||previous.evidence_id!==hit.evidence_id))
   throw new DocumentEvidenceChangedError();
  if(!previous)candidates.set(key(hit),{...hit,evidence_body:'full-page'});
 }
 if(candidates.size>15)throw new Error('Invalid adjacent PDF refinement candidate count');
 // Recheck every original anchor and added neighbor, including after cache hits.
 await readFullDocumentEvidence(pool,owner,[...candidates.values()]);
 return [...candidates.values()];
}

export async function refineSelectedDocumentPages(pool:Pool,owner:string,query:string,selected:DocumentTextHit[],count:number):Promise<DocumentTextHit[]>{
 if(!Number.isInteger(count)||count<1||count>5)throw new Error('Invalid adjacent PDF refinement limit');
 const candidates=await selectedDocumentNeighborhood(pool,owner,selected);
 const refined_from=selected.map(({document_id,page_number,source_version_id,evidence_id})=>({document_id,page_number,source_version_id,evidence_id}));
 const expanded=candidates.length>selected.length;
 const refined=expanded?await selectAdjacentDocumentPagesWithAI(pool,owner,query,candidates,Math.min(count,candidates.length)):selected;
 await readFullDocumentEvidence(pool,owner,candidates);
 return refined.map(hit=>({...hit,refinement_mode:expanded?'adjacent-pages':'no-new-neighbors',
  refinement_candidate_count:candidates.length,refined_from}));
}
