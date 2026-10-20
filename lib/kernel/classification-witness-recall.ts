import{createHash}from'node:crypto';import type{Pool}from'pg';
import type{DocumentTextHit}from'./document-search.ts';import type{planClassificationBranch}from'./classification-route-shadow.ts';
import{validateStoredContentClassification}from'./content-classifications.ts';
import{documentRoutingScopeSql,type DocumentRoutingScope}from'./document-routing-scope.ts';
import{fuseIndependentDocumentRanks}from'./document-vector.ts';

export type ClassificationWitnessReceipt={policy:'current-classification-witness-v1';status:'available'|'partial'|'empty'|'unavailable';
 candidateLimit:32;candidatePages:number;moreAvailable:boolean;skippedWitnesses:number;classificationIds:string[];
 ordinaryPages:number;witnessOnlyPages:number;referencesExpanded?:boolean;
 semanticVerified:false;filterAuthorization:false;fusion:'rrf60-preserve-heads';reason:string};
type Scope={courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),key=(h:DocumentTextHit)=>JSON.stringify([h.document_id,h.page_number]);
export function emptyClassificationWitnessReceipt(reason:string):ClassificationWitnessReceipt{
 return{policy:'current-classification-witness-v1',status:'empty',candidateLimit:32,candidatePages:0,moreAvailable:false,skippedWitnesses:0,
  classificationIds:[],ordinaryPages:0,witnessOnlyPages:0,semanticVerified:false,filterAuthorization:false,fusion:'rrf60-preserve-heads',reason};
}
/** Tags only locate candidates. Every returned body is an unchanged current
 * PostgreSQL source page; no label or alias is substituted for source content. */
export async function recallClassificationWitnesses(pool:Pool,owner:string,scope:Scope,plan:Awaited<ReturnType<typeof planClassificationBranch>>,
 ordinary:DocumentTextHit[],limit:number,full:boolean){
 const receipt=emptyClassificationWitnessReceipt('no-current-fragment-witness');
 receipt.ordinaryPages=ordinary.length;
 if(!plan.aliasExpansion?.matches.length)return{hits:ordinary,receipt};
 const args:unknown[]=[owner,JSON.stringify(plan.aliasExpansion.matches),scope.courseId||null,scope.documentId||null],
  where=documentRoutingScopeSql(scope.routingScope,args),rows=(await pool.query(`
  SELECT DISTINCT ON(d.id,p.page_number) r.*,coalesce(d.course_id,'') course_id,d.name,d.origin,d.origin_key,
   p.body page_body,p.page_number,p.locator,p.content_kind,p.start_ms::double precision,p.end_ms::double precision,
   v.parser_version,v.warnings parser_warnings,a.tag
  FROM document_content_classification_heads h JOIN document_content_classifications r
   ON r.id=h.classification_id AND r.owner_id=h.owner_id AND r.version_id=h.version_id AND r.classifier_id=h.classifier_id
  JOIN document_texts d ON d.id=r.document_id AND d.owner_id=r.owner_id AND d.current_version_id=r.version_id AND d.source_hash=r.source_hash
  JOIN document_text_versions v ON v.id=r.version_id AND v.document_id=d.id AND v.source_version_id=r.source_version_id
  CROSS JOIN LATERAL jsonb_array_elements(r.assignments) a(tag)
  JOIN document_text_pages p ON p.version_id=v.id AND p.evidence_id=a.tag#>>'{witness,evidenceId}'
   AND p.page_number::text=a.tag#>>'{witness,pageNumber}'
  WHERE d.owner_id=$1 AND NOT d.hidden
   AND ($3::text IS NULL OR d.course_id=$3) AND ($4::text IS NULL OR d.id=$4) ${where}
   AND a.tag#>>'{witness,kind}'='page' AND a.tag#>>'{scope,kind}'='fragment'
   AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS wanted(facet text,key text)
    WHERE a.tag->>'facet'=wanted.facet AND a.tag->>'key'=wanted.key)
   AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key
    AND NOT newer.hidden AND(newer.created_at>d.created_at OR(newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY d.id,p.page_number,r.id LIMIT 33`,args)).rows;
 const candidates:DocumentTextHit[]=[];
 for(const row of rows.slice(0,32)){
  try{
   validateStoredContentClassification(row);const w=row.tag.witness;
   if(hash(row.page_body)!==w.bodySha256||row.page_body.slice(w.startUtf16,w.endUtf16)!==w.text||hash(w.text)!==w.textSha256)
    throw Error('Current classification witness differs');
   candidates.push({id:`pg:${row.version_id}:${row.page_number}`,document_id:row.document_id,course_id:row.course_id,name:row.name,origin:row.origin,
    origin_key:row.origin_key,source_hash:row.source_hash,body:full?row.page_body:w.text,locator:row.locator,page_number:row.page_number,
    evidence_id:w.evidenceId,source_version_id:row.source_version_id,parser_version:row.parser_version,parser_warnings:row.parser_warnings,
    content_kind:row.content_kind,start_ms:row.start_ms,end_ms:row.end_ms,score:0,lexical_support:0,retrieval_mode:'classification-witness',
    ...(full?{evidence_body:'full-page' as const}:{})});receipt.classificationIds.push(row.id);
  }catch{receipt.skippedWitnesses++;}
 }
 receipt.candidatePages=candidates.length;receipt.moreAvailable=rows.length>32;receipt.classificationIds=[...new Set(receipt.classificationIds)];
 receipt.status=receipt.moreAvailable||receipt.skippedWitnesses?'partial':candidates.length?'available':'empty';
 if(!candidates.length)return{hits:ordinary,receipt};
 receipt.reason='source-bound-fragment-candidates';
 const fused=fuseIndependentDocumentRanks(ordinary,candidates,240),byKey=new Map(fused.map(h=>[key(h),h])),selected=new Set<string>();
 // Finite final context still needs a head from each lane; it cannot certify
 // exhaustive coverage. With a single slot preserve the ordinary head.
 for(const head of[ordinary[0],candidates[0]])if(head&&selected.size<limit)selected.add(key(head));
 for(const hit of fused)if(selected.size<limit)selected.add(key(hit));
 const hits=fused.filter(h=>selected.has(key(h))).map(h=>byKey.get(key(h))!),original=new Set(ordinary.map(key));
 receipt.witnessOnlyPages=hits.filter(h=>!original.has(key(h))).length;
 return{hits,receipt};
}
