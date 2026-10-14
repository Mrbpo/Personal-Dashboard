import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import type {DocumentTextHit} from '../lib/kernel/document-search.ts';
import {decodeDocumentEmbeddingBatch,documentCosineSimilarity,fuseDocumentPageRanks,rerankDocumentPages,
 DOCUMENT_EMBEDDING_MODEL,DOCUMENT_EMBEDDING_DIMENSIONS} from '../lib/kernel/document-semantic.ts';

const directory=mkdtempSync(join(tmpdir(),'document-semantic-tests-'));
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=directory;
process.env.OPENAI_API_KEY='dummy-never-sent';
process.env.AI_BUDGET_TEST_BYPASS='false';
process.env.AI_MONTHLY_BUDGET='5';
after(()=>rmSync(directory,{recursive:true,force:true}));
const embedding=(axis=0)=>Array.from({length:DOCUMENT_EMBEDDING_DIMENSIONS},(_,index)=>index===axis?1:0);
const key=(...parts:unknown[])=>JSON.stringify(parts);
type CachedPage={owner_id:string;version_id:string;page_number:number;input_hash:string;embedding:number[]};
type Page={owner:string;document_id:string;version_id:string;source_version_id:string;page_number:number;body:string};

// A scoped cache double permits deterministic API/cache boundaries without a PG
// server or external requests. Migration/SQL execution remains an integration gate.
class CachePool {
 pages:Page[]=[];
 pageCache=new Map<string,CachedPage>();
 queryCache=new Map<string,number[]>();
 transactions:{commits:number;rollbacks:number}={commits:0,rollbacks:0};
 reads=0;
 pool(){return this as unknown as Pool;}
 add(owner:string,count:number){
  const hits:DocumentTextHit[]=[];
  for(let index=0;index<count;index++){
   const document_id=owner+'-document-'+index,version_id='parsed-'+document_id,source_version_id='source-'+document_id;
   this.pages.push({owner,document_id,version_id,source_version_id,page_number:1,body:'Full source text '+document_id});
   hits.push({id:document_id,document_id,course_id:'course',name:document_id,origin:'upload',origin_key:document_id,
    source_hash:'source-hash',body:'Original displayed snippet '+document_id,locator:'第 1 页',page_number:1,
    evidence_id:'evidence-'+document_id,source_version_id,parser_version:'docling-v2-search',score:count-index});
  }
  return hits;
 }
 async query(sql:string,parameters:unknown[]=[]):Promise<{rows:unknown[];rowCount:number}>{
  this.reads++;
  if(sql.includes('semantic:current-pages')){
   assert.match(sql,/d\.owner_id=\$1/);assert.match(sql,/v\.id=d\.current_version_id/);
   const requested=JSON.parse(String(parameters[1])) as {document_id:string;page_number:number;source_version_id:string}[];
   const rows=requested.flatMap(item=>this.pages.filter(page=>page.owner===parameters[0]&&page.document_id===item.document_id&&
    page.page_number===item.page_number&&page.source_version_id===item.source_version_id));
   return {rows,rowCount:rows.length};
  }
  if(sql.includes('semantic:query-cache')){
   const value=this.queryCache.get(key(...parameters));
   return {rows:value?[{embedding:value}]:[],rowCount:value?1:0};
  }
  if(sql.includes('semantic:query-save')){
   this.queryCache.set(key(...parameters.slice(0,3)),parameters[3] as number[]);return {rows:[],rowCount:1};
  }
  if(sql.includes('semantic:page-cache')){
   const wanted=JSON.parse(String(parameters[2])) as {version_id:string;page_number:number;input_hash:string}[];
   const rows=wanted.flatMap(page=>{
    const cached=this.pageCache.get(key(parameters[0],page.version_id,page.page_number,parameters[1],page.input_hash));
    return cached?[cached]:[];
   });
   return {rows,rowCount:rows.length};
  }
  throw new Error('Unexpected test SQL');
 }
 async connect(){
  let staged:CachedPage[]=[];
  return {release:()=>{},query:async(sql:string,parameters:unknown[]=[])=>{
   if(sql==='BEGIN'){staged=[];return {rows:[],rowCount:0};}
   if(sql==='ROLLBACK'){staged=[];this.transactions.rollbacks++;return {rows:[],rowCount:0};}
   if(sql==='COMMIT'){
    for(const row of staged)this.pageCache.set(key(row.owner_id,row.version_id,row.page_number,DOCUMENT_EMBEDDING_MODEL,row.input_hash),row);
    this.transactions.commits++;return {rows:[],rowCount:0};
   }
   if(sql.includes('semantic:page-save')){
    assert.match(sql,/d\.current_version_id=v\.id AND d\.owner_id=\$1/);
    const rows=JSON.parse(String(parameters[2])) as Omit<CachedPage,'owner_id'>[];
    staged=rows.filter(row=>this.pages.some(page=>page.owner===parameters[0]&&page.version_id===row.version_id&&page.page_number===row.page_number))
     .map(row=>({...row,owner_id:String(parameters[0])}));
    return {rows:[],rowCount:staged.length};
   }
   throw new Error('Unexpected test transaction SQL');
  }};
 }
}

function response(inputs:string[],axis=(input:string)=>input.includes('motion')?0:1){
 return Response.json({model:DOCUMENT_EMBEDDING_MODEL,data:inputs.map((input,index)=>({index,embedding:embedding(axis(input))}))});
}

test('embedding batches require all unique indices and 768 finite values before acceptance',()=>{
 const first=embedding(0),second=embedding(1);
 assert.deepEqual(decodeDocumentEmbeddingBatch({data:[{index:1,embedding:second},{index:0,embedding:first}]},2),[first,second]);
 for(const payload of [
  {data:[{index:0,embedding:first}]},
  {data:[{index:0,embedding:first},{index:0,embedding:second}]},
  {data:[{index:-1,embedding:first},{index:1,embedding:second}]},
  {data:[{index:0,embedding:first},{index:1,embedding:second.slice(1)}]},
  {data:[{index:0,embedding:first},{index:1,embedding:[NaN,...second.slice(1)]}]},
  {data:[{index:0,embedding:first},{index:1,embedding:[Infinity,...second.slice(1)]}]},
  {model:'different-model',data:[{index:0,embedding:first},{index:1,embedding:second}]},
 ])assert.throws(()=>decodeDocumentEmbeddingBatch(payload,2));
});

test('cosine/rank fusion is stable, handles zero norms and preserves source snippets and evidence',()=>{
 assert.equal(documentCosineSimilarity([1,0],[1,0]),1);
 assert.equal(documentCosineSimilarity([1,0],[-1,0]),-1);
 assert.equal(documentCosineSimilarity([0,0],[1,0]),0);
 assert.equal(documentCosineSimilarity([1e300,0],[1e300,0]),1);
 assert.throws(()=>documentCosineSimilarity([1,Infinity],[1,0]));
 const fixture=new CachePool(),hits=fixture.add('alice',3),snapshot=JSON.stringify(hits);
 const reordered=fuseDocumentPageRanks(hits,[0,.5,1],3);
 assert.equal(reordered[0].id,hits[2].id);
 assert.equal(reordered[0].body,hits[2].body);assert.equal(reordered[0].evidence_id,hits[2].evidence_id);
 assert.deepEqual(fuseDocumentPageRanks(hits,[1,1,1],3).map(hit=>hit.id),hits.map(hit=>hit.id));
 assert.equal(JSON.stringify(hits),snapshot);
});

test('only current candidate page text is embedded and query/page caches reuse across scoped calls',async()=>{
 const fixture=new CachePool(),hits=fixture.add('alice',2),bob=fixture.add('bob',1);
 fixture.pages[1].body='The full page discusses motion. '+ 'x'.repeat(7000);
 const original=globalThis.fetch,requests:string[][]=[];
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/embeddings');
  const request=JSON.parse(String(init?.body));
  assert.equal(request.model,DOCUMENT_EMBEDDING_MODEL);assert.equal(request.dimensions,768);
  assert.equal(request.encoding_format,'float');assert.ok(init?.signal instanceof AbortSignal);
  const texts=request.input as string[];requests.push(texts);
  assert.ok(texts.every(text=>Array.from(text).length<=6000));
  assert.ok(texts.every(text=>!text.includes('Original displayed snippet')));
  return response(texts);
 };
 try{
  const ranked=await rerankDocumentPages(fixture.pool(),'alice','motion',hits,2);
  assert.equal(ranked[0].document_id,hits[1].document_id);
  assert.equal(ranked[0].body,hits[1].body);
  assert.equal(requests.length,2);
  await rerankDocumentPages(fixture.pool(),'alice','motion',[hits[1]],1);
  assert.equal(requests.length,2,'course/library reuse does not re-embed the query or cached pages');
  await assert.rejects(rerankDocumentPages(fixture.pool(),'bob','motion',hits,2),/owner scope/);
  assert.equal(requests.length,2,'cross-owner candidates cannot reach the embedding API');
  await rerankDocumentPages(fixture.pool(),'bob','motion',bob,1);
  assert.equal(requests.length,4,'the other owner does not read the first owner query cache');
  assert.equal(fixture.queryCache.size,2);
 }finally{globalThis.fetch=original;}
});

test('32-page success batches survive a later failure and resume without paid repetition',async()=>{
 const fixture=new CachePool(),hits=fixture.add('resume-owner',33),original=globalThis.fetch;
 const batchSizes:number[]=[];
 globalThis.fetch=async(_input,init)=>{
  const texts=JSON.parse(String(init?.body)).input as string[];batchSizes.push(texts.length);
  if(batchSizes.length===3)return Response.json({data:[]});
  return response(texts);
 };
 try{
  await assert.rejects(rerankDocumentPages(fixture.pool(),'resume-owner','motion',hits,5),/incomplete/);
  assert.equal(fixture.pageCache.size,32);assert.equal(fixture.transactions.commits,1);
  assert.equal((await rerankDocumentPages(fixture.pool(),'resume-owner','motion',hits,5)).length,5);
  assert.deepEqual(batchSizes,[1,32,1,1]);
  assert.equal(fixture.pageCache.size,33);
 }finally{globalThis.fetch=original;}
});

test('malformed page batches cache no members; changing current versions rolls back the batch',async()=>{
 const original=globalThis.fetch;
 try{
  for(const mode of ['partial-response','changed-version']){
   const fixture=new CachePool(),hits=fixture.add(mode,2);let requests=0;
   globalThis.fetch=async(_input,init)=>{
    const texts=JSON.parse(String(init?.body)).input as string[];requests++;
    if(requests===2){
     if(mode==='partial-response')return Response.json({data:[{index:0,embedding:embedding()}]});
     fixture.pages[1].version_id='replacement-version';fixture.pages[1].source_version_id='replacement-source';
    }
    return response(texts);
   };
   await assert.rejects(rerankDocumentPages(fixture.pool(),mode,'motion',hits,2));
   assert.equal(fixture.pageCache.size,0,'no valid-looking member of a rejected batch is published');
   assert.equal(fixture.transactions.commits,0);
   if(mode==='changed-version')assert.equal(fixture.transactions.rollbacks,1);
  }
 }finally{globalThis.fetch=original;}
});

test('missing credentials, exhausted budget and excessive candidate scope throw without requests',async()=>{
 const fixture=new CachePool(),hits=fixture.add('blocked-owner',1),original=globalThis.fetch;
 let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('No request authorized in this test');};
 const savedKey=process.env.OPENAI_API_KEY,savedBudget=process.env.AI_MONTHLY_BUDGET,savedBypass=process.env.AI_BUDGET_TEST_BYPASS;
 try{
  process.env.OPENAI_API_KEY='';
  await assert.rejects(rerankDocumentPages(fixture.pool(),'blocked-owner','motion',hits,1),/API key/);
  process.env.OPENAI_API_KEY='dummy-never-sent';process.env.AI_MONTHLY_BUDGET='0';process.env.AI_BUDGET_TEST_BYPASS='false';
  await assert.rejects(rerankDocumentPages(fixture.pool(),'blocked-owner','motion',hits,1),/预算或每日请求上限/);
  const reads=fixture.reads;
  await assert.rejects(rerankDocumentPages(fixture.pool(),'blocked-owner','motion',Array(81).fill(hits[0]),1),/scope or limit/);
  assert.equal(fixture.reads,reads);assert.equal(requests,0);assert.equal(fixture.pageCache.size,0);
 }finally{
  globalThis.fetch=original;
  for(const [name,value] of [['OPENAI_API_KEY',savedKey],['AI_MONTHLY_BUDGET',savedBudget],['AI_BUDGET_TEST_BYPASS',savedBypass]]){
   if(value===undefined)delete process.env[name!];else process.env[name!]=value;
  }
 }
});
