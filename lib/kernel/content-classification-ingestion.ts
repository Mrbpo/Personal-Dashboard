import type{PoolClient}from'pg';
import{classifyContentMetadata,CONTENT_TAG_PRODUCER,type ContentTagMetadata}from'./content-tags.ts';
import{recordContentClassification,validateContentClassification,validateStoredContentClassification}from'./content-classifications.ts';

export const METADATA_CLASSIFIER_ID='kernel/source-metadata';
const actor='kernel:source-metadata',reason='Automatic current-source metadata observations; semantic coverage unverified';
const fields={course_id:'courseId','courses.term_id':'termId',origin:'origin',mime:'mime',name:'name',origin_key:'originKey'}as const;
const stable=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

/** Short ingestion transaction only. Reuse metadata rules and the same revision
 * writer as manual corrections; no model, new store or original-text rewrite. */
export async function recordIngestedContentClassification(client:PoolClient,owner:string,documentId:string,versionId:string){
 const row=(await client.query<ContentTagMetadata&{sourceHash:string;sourceVersionId:string}>(`SELECT d.source_hash "sourceHash",v.source_version_id "sourceVersionId",
  d.course_id "courseId",c.term_id "termId",d.origin,d.origin_key "originKey",
  coalesce(s.raw_value->>'name',d.name) name,coalesce(s.raw_value->>'mime','') mime
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id LEFT JOIN courses c ON c.id=d.course_id
  WHERE d.owner_id=$1 AND d.id=$2 AND v.id=$3 AND NOT d.hidden AND NOT EXISTS(
   SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
   AND(newer.created_at>d.created_at OR(newer.created_at=d.created_at AND newer.id>d.id))) FOR UPDATE OF d`,[owner,documentId,versionId])).rows[0];
 if(!row)return{status:'skipped' as const,reason:'not-current-owned-source' as const};
 const{sourceHash,sourceVersionId,...metadata}=row,classification=classifyContentMetadata(metadata);
 const previous=(await client.query(`SELECT r.* FROM document_content_classification_heads h JOIN document_content_classifications r
  ON r.id=h.classification_id AND r.owner_id=h.owner_id AND r.version_id=h.version_id AND r.classifier_id=h.classifier_id
  WHERE h.owner_id=$1 AND h.version_id=$2 AND h.classifier_id=$3`,[owner,versionId,METADATA_CLASSIFIER_ID])).rows[0];
 const old=previous?validateStoredContentClassification(previous):undefined;
 // An explicit correction of this producer must not be undone by a sync.
 if(old&&(old.method!=='rule'||previous.actor!==actor))return{status:'skipped' as const,reason:'externally-corrected-classifier' as const};
 const input=validateContentClassification({documentId,versionId,sourceVersionId,sourceHash,classifierId:METADATA_CLASSIFIER_ID,
  producerVersion:CONTENT_TAG_PRODUCER,method:'rule',model:null,previousId:previous?.id??null,
  tags:classification.tags.map(tag=>({facet:tag.facet,key:tag.key,confidence:tag.confidence,
   evidence:{kind:'source-metadata',field:fields[tag.witness.field as keyof typeof fields],value:tag.witness.value}}))});
 if(old&&stable({...old,previousId:null})===stable({...input,previousId:null}))
  return{status:'unchanged' as const,id:previous.id};
 return{status:'recorded' as const,...await recordContentClassification(client,owner,input,actor,reason)};
}
