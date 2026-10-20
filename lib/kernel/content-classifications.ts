import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {CONTENT_TAG_FACETS,CONTENT_TAG_TAXONOMY} from './content-tags.ts';

type Facet=typeof CONTENT_TAG_FACETS[number];
type PageWitness={kind:'page';pageNumber:number;evidenceId:string;startUtf16:number;endUtf16:number;text:string};
type MetadataWitness={kind:'source-metadata';field:'name'|'mime'|'origin'|'originKey'|'courseId'|'termId';value:string};
type Tag={facet:Facet;key:string;confidence:number;evidence:PageWitness|MetadataWitness|{kind:'human-judgment'}};
export type ContentClassificationInput={documentId:string;versionId:string;sourceVersionId:string;sourceHash:string;
 classifierId:string;producerVersion:string;method:'manual'|'rule'|'model';model:string|null;previousId:string|null;tags:Tag[]};
const canonical=(value:unknown)=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v),sha=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex'),
 shaText=(value:string)=>createHash('sha256').update(value).digest('hex'),
 exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),
 text=(v:unknown,max=4000):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0'),
 hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

/** A bounded proposal, not semantic certification or permission to filter.
 * Canonical IDs keep their case; ordinary keys use one shared normalization. */
export function validateContentClassification(input:unknown):ContentClassificationInput{
 if(!exact(input,['documentId','versionId','sourceVersionId','sourceHash','classifierId','producerVersion','method','model','previousId','tags']))
  throw Error('Invalid classification fields');
 const value=structuredClone(input) as ContentClassificationInput;
 if(![value.documentId,value.versionId,value.sourceVersionId].every(v=>text(v))||!hex(value.sourceHash)||
  !text(value.classifierId,120)||!/^[-a-z0-9_./]+$/.test(value.classifierId)||!text(value.producerVersion,160)||
  !['manual','rule','model'].includes(value.method)||(value.method==='model'?!text(value.model,160):value.model!==null)||
  !(value.previousId===null||hex(value.previousId))||!Array.isArray(value.tags)||value.tags.length>64)throw Error('Invalid classification identity');
 const seen=new Set<string>();
 for(const tag of value.tags){
  if(!exact(tag,['facet','key','confidence','evidence'])||!CONTENT_TAG_FACETS.includes(tag.facet)||!text(tag.key,240)||
   !Number.isFinite(tag.confidence)||tag.confidence<0||tag.confidence>1)throw Error('Invalid classification tag');
  if(['course','term','assignment'].includes(tag.facet)){if(tag.key!==tag.key.trim())throw Error('Canonical tag ID contains padding');}
  else tag.key=tag.key.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' ');
  const e=tag.evidence;
  if(e?.kind==='page'){
   if(!exact(e,['kind','pageNumber','evidenceId','startUtf16','endUtf16','text'])||!Number.isSafeInteger(e.pageNumber)||e.pageNumber<1||
    !text(e.evidenceId)||!Number.isSafeInteger(e.startUtf16)||!Number.isSafeInteger(e.endUtf16)||e.startUtf16<0||e.endUtf16<=e.startUtf16||
    !text(e.text,2000)||e.text.length!==e.endUtf16-e.startUtf16)throw Error('Invalid classification page witness');
  }else if(e?.kind==='source-metadata'){
   if(!exact(e,['kind','field','value'])||!['name','mime','origin','originKey','courseId','termId'].includes(e.field)||!text(e.value))
    throw Error('Invalid classification metadata witness');
  }else if(e?.kind!=='human-judgment'||!exact(e,['kind'])||value.method!=='manual')throw Error('Unattributed classification judgment');
  const identity=canonical([tag.facet,tag.key,e.kind==='page'?[e.pageNumber,e.startUtf16,e.endUtf16]:'document']);
  if(seen.has(identity))throw Error('Duplicate classification tag scope');seen.add(identity);
 }
 if(Buffer.byteLength(canonical(value))>65536)throw Error('Classification exceeds byte limit');
 return value;
}

const currentSource=`NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
 AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
 AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))`;

/** Check an immutable revision before allowing it to influence an index.
 * Source identity is rechecked by its reader; a digest is not semantic proof. */
export function validateStoredContentClassification(row:Record<string,unknown>){
 if(!text(row.owner_id)||!text(row.actor,240)||!text(row.reason,2000)||row.taxonomy_version!==CONTENT_TAG_TAXONOMY||
  row.filter_authorization!==false||row.semantic_verified!==false||row.coverage!=='explicit-scopes-only'||!Array.isArray(row.assignments))
  throw Error('Invalid stored classification');
 const tags=row.assignments.map((value:unknown)=>{
  if(!exact(value,['facet','key','confidence','scope','witness','routingUse','semanticVerified']))throw Error('Invalid stored assignment');
  const a=value as Record<string,unknown>,w=a.witness as Record<string,unknown>;
  if(!w||a.routingUse!=='soft-only'||a.semanticVerified!==false)throw Error('Invalid assignment authority');
  let evidence:unknown,scope:unknown;
  if(w.kind==='page'){
   if(!exact(w,['kind','pageNumber','evidenceId','startUtf16','endUtf16','text','bodySha256','textSha256'])||!hex(w.bodySha256)||
    typeof w.text!=='string'||w.textSha256!==shaText(w.text))throw Error('Invalid stored page witness');
   const {bodySha256,textSha256,...original}=w;evidence=original;
   scope={kind:'fragment',pageNumber:w.pageNumber,startUtf16:w.startUtf16,endUtf16:w.endUtf16};
  }else{evidence=w;scope={kind:'document'};}
  if(canonical(scope)!==canonical(a.scope))throw Error('Classification scope was widened');
  return {facet:a.facet,key:a.key,confidence:a.confidence,evidence};
 });
 const request=validateContentClassification({documentId:row.document_id,versionId:row.version_id,sourceVersionId:row.source_version_id,
  sourceHash:row.source_hash,classifierId:row.classifier_id,producerVersion:row.producer_version,method:row.method,model:row.model,previousId:row.previous_id,tags});
 const expected=sha({owner:row.owner_id,taxonomy:CONTENT_TAG_TAXONOMY,request,assignments:row.assignments,actor:row.actor,reason:row.reason});
 if(row.id!==expected||row.payload_sha256!==expected||row.input_sha256!==sha(request)||
  canonical(row.unknown_facets)!==canonical(CONTENT_TAG_FACETS.filter(f=>!request.tags.some(t=>t.facet===f))))throw Error('Classification digest differs');
 return request;
}

/** The caller owns the short Kernel transaction. Fetch/AI/classification runs
 * outside it. Serialize with ingestion on the current document; never rebase. */
export async function recordContentClassification(client:PoolClient,owner:string,input:unknown,actor:string,reason:string){
 const request=validateContentClassification(input);
 if(!text(owner)||!text(actor,240)||!text(reason,2000))throw Error('Classification requires owner, actor and reason');
 const row=(await client.query<{source_hash:string;version_id:string;source_version_id:string;courseId:string|null;termId:string|null;
  name:string;mime:string;origin:string;originKey:string}>(`SELECT d.source_hash,v.id version_id,v.source_version_id,
   d.course_id "courseId",c.term_id "termId",coalesce(s.raw_value->>'name',d.name) name,coalesce(s.raw_value->>'mime','') mime,
   d.origin,d.origin_key "originKey" FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
   JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id LEFT JOIN courses c ON c.id=d.course_id
   WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.hidden AND ${currentSource} FOR UPDATE OF d`,[owner,request.documentId])).rows[0];
 if(!row||row.source_hash!==request.sourceHash||row.version_id!==request.versionId||row.source_version_id!==request.sourceVersionId)
  throw Error('Classification source is not current and owned');
 const assignments:Array<{facet:Facet;key:string;confidence:number;scope:unknown;witness:unknown;routingUse:'soft-only';semanticVerified:false}>=[];
 for(const tag of request.tags){
  const evidence=tag.evidence;let witness:unknown,scope:unknown;
  if(evidence.kind==='page'){
   const page=(await client.query<{body:string;evidence_id:string}>(`SELECT body,evidence_id FROM document_text_pages WHERE version_id=$1 AND page_number=$2`,
    [request.versionId,evidence.pageNumber])).rows[0];
   if(!page||page.evidence_id!==evidence.evidenceId||page.body.slice(evidence.startUtf16,evidence.endUtf16)!==evidence.text||evidence.endUtf16>page.body.length)
    throw Error('Classification page witness differs from original text');
   // No split surrogate pair may masquerade as a character-exact source span.
   for(const offset of [evidence.startUtf16,evidence.endUtf16])if(offset>0&&offset<page.body.length&&
    /[\uD800-\uDBFF]/u.test(page.body[offset-1])&&/[\uDC00-\uDFFF]/u.test(page.body[offset]))throw Error('Classification span splits a Unicode character');
   witness={...evidence,bodySha256:shaText(page.body),textSha256:shaText(evidence.text)};
   scope={kind:'fragment',pageNumber:evidence.pageNumber,startUtf16:evidence.startUtf16,endUtf16:evidence.endUtf16};
  }else{
   if(evidence.kind==='source-metadata'&&row[evidence.field]!==evidence.value)throw Error('Classification metadata witness differs from source');
   witness=structuredClone(evidence);scope={kind:'document'};
  }
  if(['course','term','assignment'].includes(tag.facet)){
   const table={course:'courses',term:'academic_terms',assignment:'tasks'}[tag.facet as 'course'|'term'|'assignment'];
   if(!(await client.query(`SELECT 1 FROM ${table} WHERE id=$1`,[tag.key])).rowCount)throw Error('Classification canonical reference does not exist');
  }
  assignments.push({facet:tag.facet,key:tag.key,confidence:tag.confidence,scope,witness,routingUse:'soft-only',semanticVerified:false});
 }
 const payload={owner,taxonomy:CONTENT_TAG_TAXONOMY,request,assignments,actor,reason},id=sha(payload),inputHash=sha(request),
  head=(await client.query<{classification_id:string}>('SELECT classification_id FROM document_content_classification_heads WHERE owner_id=$1 AND version_id=$2 AND classifier_id=$3',
   [owner,request.versionId,request.classifierId])).rows[0]?.classification_id??null;
 if((await client.query('SELECT 1 FROM document_content_classifications WHERE id=$1 AND owner_id=$2',[id,owner])).rowCount)
  return {id,replayed:true,current:head===id};
 if(head!==request.previousId)throw Error('Classification revision conflict; read the current head before correcting');
 const unknown=CONTENT_TAG_FACETS.filter(facet=>!assignments.some(t=>t.facet===facet));
 await client.query(`INSERT INTO document_content_classifications(id,owner_id,document_id,version_id,source_version_id,source_hash,
  taxonomy_version,
  classifier_id,producer_version,method,model,previous_id,input_sha256,payload_sha256,assignments,unknown_facets,actor,reason)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [id,owner,request.documentId,request.versionId,request.sourceVersionId,request.sourceHash,CONTENT_TAG_TAXONOMY,request.classifierId,request.producerVersion,
   request.method,request.model,request.previousId,inputHash,id,JSON.stringify(assignments),unknown,actor,reason]);
 await client.query(`INSERT INTO document_content_classification_heads(owner_id,version_id,classifier_id,classification_id) VALUES($1,$2,$3,$4)
  ON CONFLICT(owner_id,version_id,classifier_id) DO UPDATE SET classification_id=excluded.classification_id`,[owner,request.versionId,request.classifierId,id]);
 return {id,replayed:false,current:true};
}

/** Every independent classifier stays visible; no automatic winner/merge.
 * Fragment scope is never promoted into a whole-document subject label. */
export async function readContentClassifications(pool:Pool,owner:string,documentId:string){
 if(!text(owner)||!text(documentId))throw Error('Classification reader requires owner and document');
 return (await pool.query(`SELECT r.* FROM document_content_classification_heads h JOIN document_content_classifications r
  ON r.id=h.classification_id AND r.owner_id=h.owner_id AND r.version_id=h.version_id AND r.classifier_id=h.classifier_id
  JOIN document_texts d ON d.id=r.document_id AND d.owner_id=r.owner_id AND d.current_version_id=r.version_id AND d.source_hash=r.source_hash
  WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.hidden AND ${currentSource} ORDER BY r.classifier_id`,[owner,documentId])).rows;
}
