import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import type {DocumentTextHit} from '../lib/kernel/document-search.ts';
import {rerankDocumentPagesWithAI,validateDocumentPageOrder} from '../lib/kernel/document-rerank.ts';

const directory=mkdtempSync(join(tmpdir(),'document-rerank-tests-'));
process.env.DATABASE_URL=':memory:';process.env.SERVICE_VAULT_DIR=directory;
process.env.OPENAI_API_KEY='dummy-never-sent';process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
after(()=>rmSync(directory,{recursive:true,force:true}));
const key=(parts:unknown[])=>JSON.stringify(parts);

class Fixture {
 pages:{owner:string;document_id:string;version_id:string;source_version_id:string;page_number:number;body:string}[]=[];
 cache=new Map<string,string[]>();rollbacks=0;reads=0;
 pool(){return this as unknown as Pool;}
 hits(owner='alice'):DocumentTextHit[]{
  return [0,1].map(index=>{
   const id=owner+'-'+index,version='version-'+id,source='source-'+id;
   this.pages.push({owner,document_id:id,version_id:version,source_version_id:source,page_number:1,body:'Current full original page '+id+' '+ 'x'.repeat(6500)});
   return {id,document_id:id,source_version_id:source,page_number:1,body:'Original displayed snippet '+id,
    course_id:'course',name:id,origin:'upload',origin_key:id,source_hash:'hash-'+id,locator:'第 1 页',
    evidence_id:'evidence-'+id,parser_version:'docling-v2-search',score:2-index};
  });
 }
 async query(sql:string,args:unknown[]=[]):Promise<{rows:unknown[];rowCount:number}>{
  this.reads++;
  if(sql.includes('rerank:current-pages')){
   assert.match(sql,/d\.owner_id=\$1/);assert.match(sql,/v\.id=d\.current_version_id/);
   const wanted=JSON.parse(String(args[1])) as {document_id:string;source_version_id:string;page_number:number}[];
   const rows=wanted.flatMap(item=>this.pages.filter(page=>page.owner===args[0]&&page.document_id===item.document_id&&
    page.source_version_id===item.source_version_id&&page.page_number===item.page_number));
   return {rows:rows.map(row=>({...row})),rowCount:rows.length};
  }
  if(sql.includes('rerank:cache')){
   const cached=this.cache.get(key(args));return {rows:cached?[{ordered_ids:cached}]:[],rowCount:cached?1:0};
  }
  throw new Error('Unexpected test SQL');
 }
 async connect(){
  let saved:unknown[]|null=null;
  return {release:()=>{},query:async(sql:string,args:unknown[]=[])=>{
   if(sql==='BEGIN')return {rows:[],rowCount:0};
   if(sql==='ROLLBACK'){saved=null;this.rollbacks++;return {rows:[],rowCount:0};}
   if(sql==='COMMIT'){
    if(saved)this.cache.set(key(saved.slice(0,4)),JSON.parse(String(saved[4])));return {rows:[],rowCount:0};
   }
   if(sql.includes('rerank:save')){saved=args;return {rows:[],rowCount:1};}
   return this.query(sql,args);
  }};
 }
}

test('the reranker permits only a complete permutation of supplied page identities',()=>{
 assert.deepEqual(validateDocumentPageOrder({orderedIds:['p1','p0']},['p0','p1']),['p1','p0']);
 for(const value of [{orderedIds:['p0','p0']},{orderedIds:['p0','foreign-page']},{orderedIds:['p0']},
  {orderedIds:[0,1]},{orderedIds:['p0','p1'],answer:'Invented fact'},['p0','p1']])
  assert.throws(()=>validateDocumentPageOrder(value,['p0','p1']));
});

test('successful order is cached by owner/query/current texts and retains original hit evidence',async()=>{
 const fixture=new Fixture(),hits=fixture.hits(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');
  const request=JSON.parse(String(init?.body)),pages=JSON.parse(request.input[1].content).pages;
  assert.equal(request.model,'gpt-5-mini');assert.equal(request.reasoning.effort,'low');
  assert.ok(init?.signal instanceof AbortSignal);assert.equal(pages.length,2);
  assert.ok(pages.every((page:{text:string})=>Array.from(page.text).length<=6000&&!page.text.includes('displayed snippet')));
  calls++;return Response.json({output_text:JSON.stringify({orderedIds:['p1','p0']})});
 };
 try{
  const result=await rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2);
  assert.equal(result[0].document_id,hits[1].document_id);assert.equal(result[0].body,hits[1].body);
  assert.equal(result[0].evidence_id,hits[1].evidence_id);assert.equal(fixture.cache.size,1);
  assert.equal((await rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,1))[0].id,hits[1].id);
  assert.equal(calls,1);
  await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'bob','motion',hits,2),/owner scope/);
  assert.equal(calls,1);
  fixture.pages[0].version_id='new-parsed-version';fixture.pages[0].body='Updated current page';
  await rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2);
  assert.equal(calls,2,'changed parsed version and text must invalidate old cached order');
 }finally{globalThis.fetch=original;}
});

test('invalid output is retried only once and never reaches cache publication',async()=>{
 const original=globalThis.fetch;
 try{
  for(const response of [
   {output_text:JSON.stringify({orderedIds:['p0','foreign-page']})},
   {output_text:JSON.stringify({orderedIds:['p0','p0']})},
   {output_text:JSON.stringify({orderedIds:['p0']})},
   {status:'incomplete',output_text:JSON.stringify({orderedIds:['p1','p0']})},
   {output_text:'not-json'},
  ]){
   const fixture=new Fixture(),hits=fixture.hits();let calls=0;
   globalThis.fetch=async()=>{calls++;return Response.json(response);};
   await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2));
   assert.equal(calls,response.status==='incomplete'?1:2);
   assert.equal(fixture.cache.size,0);
  }
 }finally{globalThis.fetch=original;}
});

test('a valid second permutation recovers within the original deadline and caches only success',async()=>{
 const fixture=new Fixture(),hits=fixture.hits(),originalFetch=globalThis.fetch,originalNow=Date.now,
  originalTimeout=AbortSignal.timeout;
 let calls=0,elapsed=0;
 const start=originalNow(),windows:number[]=[];
 Date.now=()=>start+elapsed;
 AbortSignal.timeout=milliseconds=>{windows.push(milliseconds);return originalTimeout(milliseconds);};
 globalThis.fetch=async()=>{
  calls++;
  assert.equal(fixture.cache.size,0,'invalid first response must not be published');
  if(calls===1){elapsed=5000;return Response.json({output_text:JSON.stringify({orderedIds:['p0','p0']})});}
  return Response.json({output_text:JSON.stringify({orderedIds:['p1','p0']})});
 };
 try{
  const result=await rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2);
  assert.equal(result[0].id,hits[1].id);
  assert.equal(result[0].evidence_id,hits[1].evidence_id);
  assert.equal(calls,2);assert.equal(fixture.cache.size,1);
  assert.deepEqual(windows,[30000,25000],'repair must use only the remaining request window');
  await rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2);
  assert.equal(calls,2,'successful repair is reusable without another request');
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;AbortSignal.timeout=originalTimeout;}
});

test('HTTP, timeout and stale-page failures do not cause a repair request',async()=>{
 const original=globalThis.fetch;
 try{
  for(const failure of ['http','timeout','stale']){
   const fixture=new Fixture(),hits=fixture.hits();let calls=0;
   globalThis.fetch=async()=>{
    calls++;
    if(failure==='http')return Response.json({error:'provider unavailable'},{status:503});
    if(failure==='timeout')throw new DOMException('Mock request timeout','TimeoutError');
    fixture.pages[0].version_id='changed-before-repair';
    return Response.json({output_text:JSON.stringify({orderedIds:['p0','p0']})});
   };
   await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2));
   assert.equal(calls,1);assert.equal(fixture.cache.size,0);
  }
 }finally{globalThis.fetch=original;}
});

test('a parsed-version switch during the API request rolls back instead of returning stale evidence',async()=>{
 const fixture=new Fixture(),hits=fixture.hits(),original=globalThis.fetch;
 globalThis.fetch=async()=>{
  fixture.pages[0].version_id='replaced-during-request';
  return Response.json({output_text:JSON.stringify({orderedIds:['p1','p0']})});
 };
 try{
  await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2),/version changed/i);
  assert.equal(fixture.cache.size,0);assert.equal(fixture.rollbacks,1);
 }finally{globalThis.fetch=original;}
});

test('missing credentials, zero budget and more than 20 candidates cannot make an API call',async()=>{
 const fixture=new Fixture(),hits=fixture.hits(),original=globalThis.fetch;
 const priorKey=process.env.OPENAI_API_KEY,priorBudget=process.env.AI_MONTHLY_BUDGET;
 let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('No network permitted');};
 try{
  process.env.OPENAI_API_KEY='';
  await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2),/API key/);
  process.env.OPENAI_API_KEY='dummy-never-sent';process.env.AI_MONTHLY_BUDGET='0';
  await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',hits,2),/预算或每日请求上限/);
  const reads=fixture.reads;
  await assert.rejects(rerankDocumentPagesWithAI(fixture.pool(),'alice','motion',Array(21).fill(hits[0]),2),/scope or limit/);
  assert.equal(reads,fixture.reads);assert.equal(calls,0);assert.equal(fixture.cache.size,0);
 }finally{
  globalThis.fetch=original;
  if(priorKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=priorKey;
  if(priorBudget===undefined)delete process.env.AI_MONTHLY_BUDGET;else process.env.AI_MONTHLY_BUDGET=priorBudget;
 }
});
