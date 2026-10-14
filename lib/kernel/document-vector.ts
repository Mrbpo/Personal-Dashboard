import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {DocumentTextHit} from './document-search.ts';
import type {IngestionJob} from './jobs.ts';
import {DOCUMENT_EMBEDDING_MODEL,DOCUMENT_EMBEDDING_DIMENSIONS,DOCUMENT_EMBEDDING_BATCH_SIZE,
  embedDocumentInputs} from './document-semantic.ts';

export type DocumentVectorScope={courseId?:string;documentId?:string};
export type DocumentVectorCoverage={totalPages:number;searchablePages:number;indexedPages:number;emptyPages:number;complete:boolean};
export type DocumentVectorResult={hits:DocumentTextHit[];coverage:DocumentVectorCoverage;degradedReason?:'incomplete-vector-index'};
export type DocumentVectorPayload={owner:string;documentId:string;versionId:string;model:string;pageCursor:number};
type EmbeddingPage={version_id:string;page_number:number;input:string;input_hash:string};
type EmbedInputs=(inputs:string[],deadline:number)=>Promise<number[][]>;

// This is precisely JavaScript String.trim's whitespace set. PostgreSQL length
// and left operate on Unicode code points, matching Array.from(body).slice(0,6000).
const trimCharacters=String.fromCodePoint(9,10,11,12,13,32,160,5760,
  8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279);
const inputHash=(input:string)=>createHash('sha256').update(input).digest('hex');

export function documentVectorInput(body:string):{input:string;inputHash:string}{
  const input=Array.from(body).slice(0,6000).join('').trim();
  return {input,inputHash:inputHash(input)};
}

function scopeSql(owner:string,scope:DocumentVectorScope={},versionId?:string){
  if(!owner?.trim())throw new Error('PDF vector owner is required');
  const args:unknown[]=[owner,DOCUMENT_EMBEDDING_MODEL,trimCharacters];
  const course=scope.courseId?`AND d.course_id=$${args.push(scope.courseId)}`:'';
  const document=scope.documentId?`AND d.id=$${args.push(scope.documentId)}`:'';
  const version=versionId?`AND v.id=$${args.push(versionId)}`:'';
  const sql=`WITH current_documents AS MATERIALIZED (
    SELECT d.*,v.id version_id,v.source_version_id,v.parser_version,v.page_count
    FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
    WHERE d.owner_id=$1 AND d.hidden=false ${course} ${document} ${version}
      AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
        AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
        AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
      AND (SELECT count(*)=v.page_count AND min(page_number)=1 AND max(page_number)=v.page_count
        FROM document_text_pages WHERE version_id=v.id)),
    current_pages AS MATERIALIZED (
      SELECT d.id document_id,d.course_id,d.name,d.origin,d.origin_key,d.source_hash,
        d.version_id,d.source_version_id,d.parser_version,p.page_number,p.body,p.evidence_id,p.locator,
        btrim(left(p.body,6000),$3::text) input,
        encode(sha256(convert_to(btrim(left(p.body,6000),$3::text),'UTF8')),'hex') input_hash
      FROM current_documents d JOIN document_text_pages p ON p.version_id=d.version_id)`;
  return {sql,args};
}

function coverageRow(row:{total_pages:unknown;searchable_pages:unknown;indexed_pages:unknown}):DocumentVectorCoverage{
  const totalPages=Number(row.total_pages),searchablePages=Number(row.searchable_pages),indexedPages=Number(row.indexed_pages);
  return {totalPages,searchablePages,indexedPages,emptyPages:totalPages-searchablePages,complete:indexedPages===searchablePages};
}

/** Coverage counts the whole requested current scope, never just keyword hits. */
export async function documentVectorCoverage(pool:Pool,owner:string,scope:DocumentVectorScope={}):Promise<DocumentVectorCoverage>{
  const {sql,args}=scopeSql(owner,scope);
  const row=(await pool.query(`/* vector:coverage */ ${sql}
    SELECT count(*) total_pages,count(*) FILTER (WHERE p.input<>'') searchable_pages,
      count(*) FILTER (WHERE p.input<>'' AND public.vector_norm(e.embedding_vector)>0) indexed_pages
    FROM current_pages p LEFT JOIN document_page_embeddings e
      ON e.owner_id=$1 AND e.version_id=p.version_id AND e.page_number=p.page_number
        AND e.model=$2 AND e.input_hash=p.input_hash`,args)).rows[0];
  return coverageRow(row);
}

/** Exact independent dense recall. No page embeddings are generated on this path. */
export async function searchDocumentVectorText(pool:Pool,owner:string,queryVector:readonly number[],
  options:DocumentVectorScope&{limit?:number}={}):Promise<DocumentVectorResult>{
  if(queryVector.length!==DOCUMENT_EMBEDDING_DIMENSIONS||queryVector.some(value=>!Number.isFinite(Math.fround(value)))||
    !queryVector.some(value=>Math.fround(value)!==0))throw new Error('Invalid PDF query vector');
  const limit=options.limit??80;
  if(!Number.isInteger(limit)||limit<1||limit>240)throw new Error('Invalid PDF dense candidate limit');
  const {sql,args}=scopeSql(owner,options),vectorArg=args.push(JSON.stringify(queryVector)),limitArg=args.push(limit);
  // Coverage and candidates share one statement snapshot, preventing a concurrent
  // reparse from pairing a complete old count with incomplete new results.
  const row=(await pool.query<{coverage:{total_pages:number;searchable_pages:number;indexed_pages:number};hits:DocumentTextHit[]}>(`
    /* vector:recall */ ${sql},indexed AS MATERIALIZED (
      SELECT p.*,e.embedding_vector FROM current_pages p JOIN document_page_embeddings e
        ON e.owner_id=$1 AND e.version_id=p.version_id AND e.page_number=p.page_number
          AND e.model=$2 AND e.input_hash=p.input_hash
      WHERE p.input<>'' AND public.vector_norm(e.embedding_vector)>0),ranked AS (
      SELECT 'pg:'||p.version_id||':'||p.page_number id,p.document_id,coalesce(p.course_id,'') course_id,
        p.name,p.origin,p.origin_key,p.source_hash,p.body,p.locator,p.page_number,p.evidence_id,
        p.source_version_id,p.parser_version,1-(p.embedding_vector OPERATOR(public.<=>)$${vectorArg}::public.vector) score
      FROM indexed p ORDER BY p.embedding_vector OPERATOR(public.<=>)$${vectorArg}::public.vector,p.document_id,p.page_number LIMIT $${limitArg})
    SELECT jsonb_build_object('total_pages',(SELECT count(*) FROM current_pages),
      'searchable_pages',(SELECT count(*) FROM current_pages WHERE input<>''),
      'indexed_pages',(SELECT count(*) FROM indexed)) coverage,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.score DESC,r.document_id,r.page_number) FROM ranked r),'[]'::jsonb) hits`,args)).rows[0];
  const coverage=coverageRow(row.coverage);
  return {coverage,hits:row.hits.map(hit=>({...hit,score:Number(hit.score),retrieval_mode:'semantic' as const})),
    ...(coverage.complete?{}:{degradedReason:'incomplete-vector-index' as const})};
}

/** RRF combines independent sets, including pages absent from lexical recall. */
export function fuseIndependentDocumentRanks(lexical:DocumentTextHit[],dense:DocumentTextHit[],limit=80):DocumentTextHit[]{
  if(!Number.isInteger(limit)||limit<0||limit>240)throw new Error('Invalid PDF fusion limit');
  const rows=new Map<string,{hit:DocumentTextHit;score:number}>();
  for(const ranking of [lexical,dense]){
    const seen=new Set<string>();
    ranking.forEach((hit,index)=>{
      const key=JSON.stringify([hit.document_id,hit.page_number]);
      if(seen.has(key))return;
      seen.add(key);
      const existing=rows.get(key);
      if(existing&&(existing.hit.source_version_id!==hit.source_version_id||existing.hit.evidence_id!==hit.evidence_id))
        throw new Error('PDF fusion candidate versions conflict');
      const score=1/(60+index+1);
      if(existing)existing.score+=score;
      else rows.set(key,{hit,score});
    });
  }
  return [...rows.values()].sort((a,b)=>b.score-a.score||a.hit.document_id.localeCompare(b.hit.document_id)||
    a.hit.page_number-b.hit.page_number).slice(0,limit).map(({hit,score})=>({...hit,score}));
}

/** Preserve each modality's head before the fused tail: an otherwise strong
 * lexical-only page must not be removed simply because many weaker pages occur
 * in both lists. Duplicate heads free slots for actual adjacent-page evidence.
 * Fully disjoint 20/20 heads already fill the fixed 40-page input budget. */
export async function buildHybridDocumentCandidates(pool:Pool,owner:string,lexical:DocumentTextHit[],dense:DocumentTextHit[]):Promise<DocumentTextHit[]>{
  if(!owner?.trim())throw new Error('PDF hybrid candidate owner is required');
  const fused=fuseIndependentDocumentRanks(lexical,dense,160),selected=new Map<string,DocumentTextHit>();
  const key=(hit:DocumentTextHit)=>JSON.stringify([hit.document_id,hit.page_number]);
  const scores=new Map(fused.map(hit=>[key(hit),hit.score]));
  const add=(hit:DocumentTextHit)=>{
    const previous=selected.get(key(hit));
    if(previous&&(previous.source_version_id!==hit.source_version_id||previous.evidence_id!==hit.evidence_id))
      throw new Error('PDF hybrid candidate versions conflict');
    if(!previous&&selected.size<40)selected.set(key(hit),{...hit,score:scores.get(key(hit))??hit.score});
  };
  for(let index=0;index<20;index++)for(const hit of [lexical[index],dense[index]])if(hit)add(hit);
  const heads=[...selected.values()];
  const byDocument=new Map<string,DocumentTextHit>();
  for(const hit of fused){if(!byDocument.has(hit.document_id))byDocument.set(hit.document_id,hit);if(byDocument.size===4)break;}
  const anchors=[...byDocument.values()];
  const neighborKeys=new Set<string>();
  if(selected.size<40&&anchors.length){
    const neighbors=(await pool.query<DocumentTextHit&{anchor_number:number}>(`/* vector:adjacent-evidence */
      WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
        AS r(document_id text,page_number integer,source_version_id text,anchor_number integer))
      SELECT 'pg:'||v.id||':'||p.page_number id,d.id document_id,coalesce(d.course_id,'') course_id,
        d.name,d.origin,d.origin_key,d.source_hash,p.body,p.locator,p.page_number,p.evidence_id,
        v.source_version_id,v.parser_version,0::double precision score,r.anchor_number
      FROM requested r JOIN document_texts d ON d.id=r.document_id AND d.owner_id=$1 AND d.hidden=false
        JOIN document_text_versions v ON v.id=d.current_version_id AND v.source_version_id=r.source_version_id
        JOIN document_text_pages p ON p.version_id=v.id AND p.page_number IN (r.page_number-1,r.page_number+1)
        JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
      WHERE p.page_number>=1 AND p.page_number<=v.page_count AND btrim(p.body)<>''
        AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
          AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
          AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
      ORDER BY r.anchor_number,p.page_number`,[owner,JSON.stringify(anchors.map((hit,index)=>({
        document_id:hit.document_id,page_number:hit.page_number,source_version_id:hit.source_version_id,anchor_number:index})))])).rows;
    for(const neighbor of neighbors){
      const {anchor_number,...hit}=neighbor;
      const anchor=anchors[anchor_number];
      if(!anchor||hit.document_id!==anchor.document_id||hit.source_version_id!==anchor.source_version_id||
        Math.abs(hit.page_number-anchor.page_number)!==1||!hit.evidence_id)
        throw new Error('Invalid PDF adjacent-page evidence');
      if(!selected.has(key(hit))&&selected.size<40){neighborKeys.add(key(hit));add({...hit,score:anchor.score/2});}
    }
  }
  for(const hit of fused)add(hit);
  // Keep relevance order for original candidates; neighbors follow their parent
  // when both are present, rather than being hidden at the end of the input.
  const output:DocumentTextHit[]=[],seen=new Set<string>();
  const emit=(hit:DocumentTextHit)=>{const item=selected.get(key(hit));if(item&&!seen.has(key(item))){seen.add(key(item));output.push(item);}};
  for(const hit of fused){
    if(!neighborKeys.has(key(hit)))emit(hit);
    const anchor=anchors.find(anchor=>key(anchor)===key(hit));
    if(anchor)for(const item of selected.values())if(neighborKeys.has(key(item))&&item.document_id===anchor.document_id&&
      Math.abs(item.page_number-anchor.page_number)===1)emit(item);
  }
  for(const hit of [...heads,...selected.values()])emit(hit);
  return output;
}

/** Only missing embeddings in complete, current document versions are queued. */
export async function queueDocumentVectorJobs(pool:Pick<Pool,'query'>,owner:string,scope:DocumentVectorScope={}):Promise<string[]>{
  const {sql,args}=scopeSql(owner,scope);
  const versions=(await pool.query<{document_id:string;version_id:string}>(`/* vector:queue-candidates */ ${sql}
    SELECT DISTINCT p.document_id,p.version_id FROM current_pages p WHERE p.input<>'' AND NOT EXISTS (
      SELECT 1 FROM document_page_embeddings e WHERE e.owner_id=$1 AND e.version_id=p.version_id
        AND e.page_number=p.page_number AND e.model=$2 AND e.input_hash=p.input_hash
        AND public.vector_norm(e.embedding_vector)>0)
    ORDER BY p.document_id,p.version_id`,args)).rows;
  const ids:string[]=[];
  for(const version of versions){
    const payload:DocumentVectorPayload={owner,documentId:version.document_id,versionId:version.version_id,
      model:DOCUMENT_EMBEDDING_MODEL,pageCursor:0};
    const idempotencyKey=`document-vectors:${inputHash(JSON.stringify([owner,version.version_id,DOCUMENT_EMBEDDING_MODEL]))}`;
    const row=(await pool.query<{id:string}>(`INSERT INTO ingestion_jobs(id,kind,source,scope,payload,idempotency_key)
      VALUES ($1,'document_vectors','document',$2,$3::jsonb,$4) ON CONFLICT(idempotency_key) DO UPDATE SET
        state=CASE WHEN ingestion_jobs.state IN ('complete','failed') THEN 'queued' ELSE ingestion_jobs.state END,
        attempts=CASE WHEN ingestion_jobs.state IN ('complete','failed') THEN 0 ELSE ingestion_jobs.attempts END,
        available_at=CASE WHEN ingestion_jobs.state IN ('complete','failed') THEN now() ELSE ingestion_jobs.available_at END,
        last_error=CASE WHEN ingestion_jobs.state IN ('complete','failed') THEN NULL ELSE ingestion_jobs.last_error END,
        updated_at=now() RETURNING id`,[randomUUID(),version.document_id,JSON.stringify(payload),idempotencyKey])).rows[0];
    ids.push(row.id);
  }
  return ids;
}

function validatePayload(raw:unknown):DocumentVectorPayload{
  if(!raw||typeof raw!=='object')throw new Error('Invalid PDF vector job payload');
  const value=raw as DocumentVectorPayload;
  if(!value.owner?.trim()||!value.documentId||!value.versionId||value.model!==DOCUMENT_EMBEDDING_MODEL||
    !Number.isInteger(value.pageCursor)||value.pageCursor<0)throw new Error('Invalid PDF vector job identity');
  return value;
}

/** Worker owns renewal/finish/retry. Network calls occur outside the short cache
 * and checkpoint transaction. Existing successful batches survive all retries. */
export async function runDocumentVectorJob(pool:Pool,job:IngestionJob,options:{embed?:EmbedInputs}={}):Promise<{
  indexedPages:number;obsolete:boolean;
}>{
  if(job.kind!=='document_vectors'||!job.lease_token)throw new Error('Invalid PDF vector job');
  const initial=validatePayload(job.payload),embed=options.embed??embedDocumentInputs;
  let indexedPages=0;
  for(;;){
    const leased=(await pool.query<{payload:unknown}>(`/* vector:job-read */ SELECT payload FROM ingestion_jobs
      WHERE id=$1 AND lease_token=$2 AND kind='document_vectors' AND state='running' AND lease_until>now()`,
      [job.id,job.lease_token])).rows[0];
    if(!leased)throw new Error('PDF vector ingestion lease lost');
    const payload=validatePayload(leased.payload);
    if(payload.owner!==initial.owner||payload.documentId!==initial.documentId||payload.versionId!==initial.versionId)
      throw new Error('PDF vector job identity changed');
    const {sql,args}=scopeSql(payload.owner,{documentId:payload.documentId},payload.versionId);
    const cursor=args.push(payload.pageCursor),batchLimit=args.push(DOCUMENT_EMBEDDING_BATCH_SIZE);
    const current=(await pool.query<{current:boolean;pages:EmbeddingPage[]}>(`/* vector:missing-pages */ ${sql},missing AS (
      SELECT p.version_id,p.page_number,p.input,p.input_hash FROM current_pages p
      WHERE p.input<>'' AND NOT EXISTS (SELECT 1 FROM document_page_embeddings e WHERE e.owner_id=$1
        AND e.version_id=p.version_id AND e.page_number=p.page_number AND e.model=$2 AND e.input_hash=p.input_hash
        AND public.vector_norm(e.embedding_vector)>0)
      ORDER BY (p.page_number>$${cursor}) DESC,p.page_number LIMIT $${batchLimit})
      SELECT EXISTS(SELECT 1 FROM current_documents) current,
        coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY (m.page_number>$${cursor}) DESC,m.page_number) FROM missing m),'[]'::jsonb) pages`,args)).rows[0];
    if(!current.current)return {indexedPages,obsolete:true};
    if(!current.pages.length)return {indexedPages,obsolete:false};
    const batch=current.pages;
    const embeddings=await embed(batch.map(page=>page.input),Date.now()+30000);
    if(embeddings.length!==batch.length||embeddings.some(vector=>vector.length!==DOCUMENT_EMBEDDING_DIMENSIONS||
      vector.some(value=>!Number.isFinite(Math.fround(value)))||!vector.some(value=>Math.fround(value)!==0)))throw new Error('Invalid PDF index embedding batch');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const locked=(await client.query<{payload:unknown}>(`/* vector:lease-lock */ SELECT payload FROM ingestion_jobs
        WHERE id=$1 AND lease_token=$2 AND kind='document_vectors' AND state='running' AND lease_until>now() FOR UPDATE`,
        [job.id,job.lease_token])).rows[0];
      if(!locked||JSON.stringify(validatePayload(locked.payload))!==JSON.stringify(payload))throw new Error('PDF vector ingestion lease or checkpoint changed');
      // Lock the version pointer through the commit. A reparse cannot publish a
      // replacement between validation, cache insertion and checkpoint update.
      const document=(await client.query(`SELECT d.id FROM document_texts d WHERE d.owner_id=$1 AND d.id=$2
        AND d.current_version_id=$3 AND d.hidden=false AND NOT EXISTS (SELECT 1 FROM document_texts newer
          WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
          AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id))) FOR UPDATE`,
        [payload.owner,payload.documentId,payload.versionId])).rows[0];
      if(!document){await client.query('ROLLBACK');return {indexedPages,obsolete:true};}
      const saved=await client.query(`/* vector:cache-save */ INSERT INTO document_page_embeddings
        (owner_id,version_id,page_number,model,input_hash,embedding)
        SELECT $1,r.version_id,r.page_number,$2,r.input_hash,
          ARRAY(SELECT jsonb_array_elements_text(r.embedding)::double precision)
        FROM jsonb_to_recordset($3::jsonb) AS r(version_id text,page_number integer,input_hash text,embedding jsonb)
          JOIN document_text_pages p ON p.version_id=r.version_id AND p.page_number=r.page_number
        WHERE r.version_id=$4 AND r.input_hash=encode(sha256(convert_to(btrim(left(p.body,6000),$5::text),'UTF8')),'hex')
        ON CONFLICT(owner_id,version_id,page_number,model,input_hash) DO UPDATE
          SET embedding=excluded.embedding WHERE public.vector_norm(document_page_embeddings.embedding_vector)=0`,
        [payload.owner,DOCUMENT_EMBEDDING_MODEL,JSON.stringify(batch.map((page,index)=>({...page,embedding:embeddings[index]}))),
          payload.versionId,trimCharacters]);
      // Concurrent query reranking may have filled some batch members. Validate
      // all members exist instead of mistaking an idempotent conflict for loss.
      const count=Number((await client.query(`SELECT count(*) n FROM document_page_embeddings e
        JOIN jsonb_to_recordset($3::jsonb) AS r(version_id text,page_number integer,input_hash text)
          ON e.version_id=r.version_id AND e.page_number=r.page_number AND e.input_hash=r.input_hash
        WHERE e.owner_id=$1 AND e.model=$2 AND public.vector_norm(e.embedding_vector)>0`,[payload.owner,DOCUMENT_EMBEDDING_MODEL,JSON.stringify(batch)])).rows[0].n);
      if(count!==batch.length)throw new Error('PDF page changed during vector indexing');
      const pageCursor=Math.max(payload.pageCursor,...batch.map(page=>page.page_number));
      const checkpoint=await client.query(`UPDATE ingestion_jobs SET payload=jsonb_set(payload,'{pageCursor}',$3::jsonb),
        stage=$4,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now()`,
        [job.id,job.lease_token,JSON.stringify(pageCursor),`vector_index:${pageCursor}`]);
      if(checkpoint.rowCount!==1)throw new Error('PDF vector ingestion lease lost');
      await client.query('COMMIT');
      indexedPages+=saved.rowCount??0;
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
}
