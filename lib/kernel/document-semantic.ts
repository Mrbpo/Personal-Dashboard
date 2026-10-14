import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {paidOpenAI} from '../ai-budget.ts';
import {serviceValue} from '../service-vault.ts';
import type {DocumentTextHit} from './document-search.ts';

export const DOCUMENT_EMBEDDING_MODEL='text-embedding-3-small';
export const DOCUMENT_EMBEDDING_DIMENSIONS=768;
export const DOCUMENT_EMBEDDING_BATCH_SIZE=32;
export const DOCUMENT_SEMANTIC_CANDIDATE_LIMIT=80;
const PAGE_INPUT_LIMIT=6000,REQUEST_TIMEOUT_MS=15000,TOTAL_REQUEST_WINDOW_MS=30000;
const hash=(input:string)=>createHash('sha256').update(input).digest('hex');
const pageKey=(document:string,page:number)=>JSON.stringify([document,page]);
type CurrentPage={document_id:string;version_id:string;page_number:number;source_version_id:string;body:string};
type PageInput=CurrentPage&{input:string;input_hash:string};
const queryFlights=new WeakMap<Pool,Map<string,Promise<number[]>>>();

function vector(value:unknown):number[]{
 if(!Array.isArray(value)||value.length!==DOCUMENT_EMBEDDING_DIMENSIONS)throw new Error('PDF search embedding dimension is invalid');
 for(let index=0;index<value.length;index++)if(typeof value[index]!=='number'||!Number.isFinite(value[index]))
  throw new Error('PDF search embedding contains invalid values');
 return value;
}

/** Validate the entire response before any batch member is cached. */
export function decodeDocumentEmbeddingBatch(payload:unknown,count:number):number[][]{
 if(!payload||typeof payload!=='object'||!Number.isInteger(count)||count<1||count>DOCUMENT_EMBEDDING_BATCH_SIZE)
  throw new Error('PDF search embedding response is invalid');
 const result=payload as {data?:unknown;model?:unknown};
 if((result.model!==undefined&&result.model!==DOCUMENT_EMBEDDING_MODEL)||!Array.isArray(result.data)||result.data.length!==count)
  throw new Error('PDF search embedding batch is incomplete');
 const output:number[][]=Array(count),seen=new Set<number>();
 for(const raw of result.data){
  if(!raw||typeof raw!=='object')throw new Error('PDF search embedding item is invalid');
  const item=raw as {index?:unknown;embedding?:unknown},index=item.index;
  if(typeof index!=='number'||!Number.isInteger(index)||index<0||index>=count||seen.has(index))
   throw new Error('PDF search embedding indices are invalid');
  seen.add(index);output[index]=vector(item.embedding);
 }
 return output;
}

export function documentCosineSimilarity(left:readonly number[],right:readonly number[]):number{
 if(!left.length||left.length!==right.length||
  [...left,...right].some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new Error('Invalid cosine vectors');
 const leftScale=Math.max(...left.map(Math.abs)),rightScale=Math.max(...right.map(Math.abs));
 if(!leftScale||!rightScale)return 0;
 let dot=0,leftNorm=0,rightNorm=0;
 for(let index=0;index<left.length;index++){
  const a=left[index]/leftScale,b=right[index]/rightScale;
  dot+=a*b;leftNorm+=a*a;rightNorm+=b*b;
 }
 return Math.max(-1,Math.min(1,dot/Math.sqrt(leftNorm*rightNorm)));
}

/** Weighted reciprocal-rank fusion uses generic ranks, not corpus-specific rules. */
export function fuseDocumentPageRanks(hits:DocumentTextHit[],similarities:number[],limit:number):DocumentTextHit[]{
 if(similarities.length!==hits.length||similarities.some(value=>!Number.isFinite(value)))throw new Error('Invalid semantic ranking');
 const semanticOrder=hits.map((_,index)=>index).sort((a,b)=>similarities[b]-similarities[a]||a-b);
 const ranks=new Map(semanticOrder.map((index,rank)=>[index,rank+1]));
 return hits.map((hit,index)=>({hit,index,score:.65/(60+ranks.get(index)!)+.35/(61+index)}))
  .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,Math.max(0,limit))
  .map(({hit,score})=>({...hit,score}));
}

async function embed(inputs:string[],deadline:number):Promise<number[][]>{
 if(!serviceValue('OPENAI_API_KEY'))throw new Error('PDF semantic search requires an OpenAI API key');
 const remaining=deadline-Date.now();
 if(remaining<=0)throw new Error('PDF semantic search time limit reached');
 const response=await paidOpenAI('embeddings',{model:DOCUMENT_EMBEDDING_MODEL,dimensions:DOCUMENT_EMBEDDING_DIMENSIONS,
  encoding_format:'float',input:inputs},AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS,remaining)),
  {kind:'pdf-search-embedding',dailyLimit:200});
 if(!response.ok)throw new Error(`PDF search embedding request failed (${response.status})`);
 return decodeDocumentEmbeddingBatch(await response.json(),inputs.length);
}

async function queryVector(pool:Pool,owner:string,input:string,deadline:number):Promise<number[]>{
 let flights=queryFlights.get(pool);
 if(!flights){flights=new Map();queryFlights.set(pool,flights);}
 const queryHash=hash(input),key=JSON.stringify([owner,DOCUMENT_EMBEDDING_MODEL,queryHash]);
 const pending=flights.get(key);if(pending)return pending;
 const work=(async()=>{
  const cached=(await pool.query<{embedding:number[]}>(`/* semantic:query-cache */
   SELECT embedding FROM document_query_embeddings WHERE owner_id=$1 AND query_hash=$2 AND model=$3`,
   [owner,queryHash,DOCUMENT_EMBEDDING_MODEL])).rows[0];
  if(cached)return vector(cached.embedding);
  const [embedding]=await embed([input],deadline);
  await pool.query(`/* semantic:query-save */ INSERT INTO document_query_embeddings(owner_id,query_hash,model,embedding)
   VALUES ($1,$2,$3,$4::double precision[]) ON CONFLICT(owner_id,query_hash,model) DO NOTHING`,
   [owner,queryHash,DOCUMENT_EMBEDDING_MODEL,embedding]);
  return embedding;
 })();
 flights.set(key,work);
 try{return await work;}finally{flights.delete(key);}
}

function requestedPages(hits:DocumentTextHit[]){
 return hits.map(hit=>({document_id:hit.document_id,page_number:hit.page_number,source_version_id:hit.source_version_id}));
}

async function currentPages(pool:Pool,owner:string,hits:DocumentTextHit[],fullText=true):Promise<CurrentPage[]>{
 const rows=(await pool.query<CurrentPage>(`/* semantic:current-pages */
  WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
   AS r(document_id text,page_number integer,source_version_id text))
  SELECT d.id document_id,v.id version_id,p.page_number,v.source_version_id,${fullText?'p.body':"''::text"} body
  FROM requested r JOIN document_texts d ON d.id=r.document_id AND d.owner_id=$1 AND d.hidden=false
   JOIN document_text_versions v ON v.id=d.current_version_id AND v.source_version_id=r.source_version_id
   JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=r.page_number
  WHERE NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
   AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
   AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))`,
  [owner,JSON.stringify(requestedPages(hits))])).rows;
 if(rows.length!==hits.length)throw new Error('PDF semantic candidates are stale, missing or outside the owner scope');
 return rows;
}

async function savePageBatch(pool:Pool,owner:string,batch:PageInput[],embeddings:number[][]):Promise<void>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const saved=await client.query(`/* semantic:page-save */
   INSERT INTO document_page_embeddings(owner_id,version_id,page_number,model,input_hash,embedding)
   SELECT $1,r.version_id,r.page_number,$2,r.input_hash,
    ARRAY(SELECT jsonb_array_elements_text(r.embedding)::double precision)
   FROM jsonb_to_recordset($3::jsonb) AS r(version_id text,page_number integer,input_hash text,embedding jsonb)
    JOIN document_text_versions v ON v.id=r.version_id
    JOIN document_texts d ON d.id=v.document_id AND d.current_version_id=v.id AND d.owner_id=$1 AND d.hidden=false
    JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=r.page_number
   ON CONFLICT(owner_id,version_id,page_number,model,input_hash) DO UPDATE
    SET embedding=document_page_embeddings.embedding`,
   [owner,DOCUMENT_EMBEDDING_MODEL,JSON.stringify(batch.map((page,index)=>
    ({version_id:page.version_id,page_number:page.page_number,input_hash:page.input_hash,embedding:embeddings[index]})))]);
  if(saved.rowCount!==batch.length)throw new Error('PDF version changed during semantic indexing');
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();}
}

/** Only filtered candidates are read; callers must catch errors and retain keyword results. */
export async function rerankDocumentPages(pool:Pool,owner:string,query:string,hits:DocumentTextHit[],limit:number):Promise<DocumentTextHit[]>{
 if(!owner||hits.length>DOCUMENT_SEMANTIC_CANDIDATE_LIMIT||!Number.isInteger(limit)||limit<1||limit>80)
  throw new Error('Invalid PDF semantic candidate scope or limit');
 if(!hits.length)return [];
 const unique=new Map<string,DocumentTextHit>();
 for(const hit of hits){
  if(!hit.document_id||!hit.source_version_id||!Number.isInteger(hit.page_number)||hit.page_number<1)
   throw new Error('Invalid PDF semantic candidate identity');
  const key=pageKey(hit.document_id,hit.page_number),previous=unique.get(key);
  if(previous&&previous.source_version_id!==hit.source_version_id)throw new Error('Conflicting PDF semantic candidate versions');
  if(!previous)unique.set(key,hit);
 }
 const candidates=[...unique.values()],deadline=Date.now()+TOTAL_REQUEST_WINDOW_MS;
 const input=Array.from(query.normalize('NFKC').replace(/\s+/gu,' ').trim()).slice(0,4000).join('');
 if(!input)throw new Error('PDF semantic query is empty');
 const pages=(await currentPages(pool,owner,candidates)).map(page=>{
  const input=Array.from(page.body).slice(0,PAGE_INPUT_LIMIT).join('').trim();
  if(!input)throw new Error('PDF semantic candidate has no readable text');
  return {...page,input,input_hash:hash(input)};
 });
 const cached=(await pool.query<{version_id:string;page_number:number;input_hash:string;embedding:number[]}>(`/* semantic:page-cache */
  SELECT e.version_id,e.page_number,e.input_hash,e.embedding FROM document_page_embeddings e
   JOIN jsonb_to_recordset($3::jsonb) AS r(version_id text,page_number integer,input_hash text)
    ON e.version_id=r.version_id AND e.page_number=r.page_number AND e.input_hash=r.input_hash
  WHERE e.owner_id=$1 AND e.model=$2`,[owner,DOCUMENT_EMBEDDING_MODEL,
   JSON.stringify(pages.map(({version_id,page_number,input_hash})=>({version_id,page_number,input_hash})))])).rows;
 const byVersionPage=new Map(cached.map(page=>[pageKey(page.version_id,page.page_number),vector(page.embedding)]));
 const missing=pages.filter(page=>!byVersionPage.has(pageKey(page.version_id,page.page_number)));
 const queryEmbedding=await queryVector(pool,owner,input,deadline);
 for(let start=0;start<missing.length;start+=DOCUMENT_EMBEDDING_BATCH_SIZE){
  const batch=missing.slice(start,start+DOCUMENT_EMBEDDING_BATCH_SIZE),embeddings=await embed(batch.map(page=>page.input),deadline);
  await savePageBatch(pool,owner,batch,embeddings);
  batch.forEach((page,index)=>byVersionPage.set(pageKey(page.version_id,page.page_number),embeddings[index]));
 }
 const current=await currentPages(pool,owner,candidates,false);
 const byDocumentPage=new Map(pages.map(page=>[pageKey(page.document_id,page.page_number),page]));
 if(current.some(page=>byDocumentPage.get(pageKey(page.document_id,page.page_number))?.version_id!==page.version_id))
  throw new Error('PDF version changed during semantic ranking');
 const similarities=candidates.map(hit=>{
  const page=byDocumentPage.get(pageKey(hit.document_id,hit.page_number))!;
  return documentCosineSimilarity(queryEmbedding,byVersionPage.get(pageKey(page.version_id,page.page_number))!);
 });
 return fuseDocumentPageRanks(candidates,similarities,limit);
}
