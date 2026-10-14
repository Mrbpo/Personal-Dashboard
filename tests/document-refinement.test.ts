import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {selectedDocumentNeighborhood,refineSelectedDocumentPages} from '../lib/kernel/document-refinement.ts';
import {DocumentEvidenceChangedError} from '../lib/kernel/document-evidence.ts';
import {withDocumentRerankRunPolicy} from '../lib/kernel/document-rerank.ts';
import {queueDocumentVectorJobs,runDocumentVectorJob} from '../lib/kernel/document-vector.ts';
import {claimIngestionJob,finishIngestionJob} from '../lib/kernel/jobs.ts';

const pg={skip:!process.env.KERNEL_DATABASE_URL};
const directory=mkdtempSync(join(tmpdir(),'document-refinement-tests-'));
process.env.DATABASE_URL=':memory:';process.env.SERVICE_VAULT_DIR=directory;process.env.AI_BUDGET_TEST_BYPASS='false';
const originalFetch=globalThis.fetch;let calls=0;
globalThis.fetch=async()=>{calls++;throw new Error('No unmocked network request permitted');};
after(async()=>{globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
async function fixture(bodies:string[],mime='application/pdf',timeSegmentAnchor=false){
 await migrateKernel();const tag=randomUUID(),owner='adjacent-owner-'+tag,courseId='adjacent-course-'+tag;
 await kernel.upsertCourse({id:courseId,name:'Adjacent evidence fixture',course_code:'ADJ'});
 const document={id:'adjacent-document-'+tag,ownerId:owner,courseId,name:'Fixture source',hash:tag,mime,origin:'adjacent-fixture',originKey:tag};
 const pages=bodies.map((text,index)=>({pageNumber:index+1,locator:'Original page '+(index+1),text}));
 if(timeSegmentAnchor)Object.assign(pages[0],{contentKind:'time_segment',startMs:0,endMs:1000});
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'adjacent-test-v1',warnings:['Original math remains unverified.']});
 const hits=await kernel.searchDocumentText(owner,'quartz',{limit:14,semantic:false,aiRerank:false,hybrid:false,evidenceBody:'full-page'});
 return {owner,document,pages,hits,pool:kernelPool()};
}

test('only selected PDF pages expand into same-version original neighbors, deduplicated and bounded',pg,async()=>{
 const item=await fixture(['Quartz p1','Quartz p2','Quartz p3','Quartz p4','Quartz p5','Quartz p6','Quartz p7',
  'Quartz p8','Quartz p9','Quartz p10','Quartz p11','Quartz p12','Quartz p13','Quartz p14']);
 const chosen=[2,5,8,11,14].map(page=>item.hits.find(hit=>hit.page_number===page)!);
 const before=JSON.stringify(chosen),pool=await selectedDocumentNeighborhood(item.pool,item.owner,chosen);
 assert.equal(JSON.stringify(chosen),before);assert.equal(pool.length,14);assert.ok(pool.length<=15);
 assert.deepEqual(pool.slice(0,5),chosen);assert.ok(pool.some(hit=>hit.page_number===10));
 assert.ok(pool.every(hit=>hit.source_version_id===chosen[0].source_version_id&&hit.course_id===chosen[0].course_id));
 assert.ok(pool.every(hit=>hit.parser_warnings?.includes('Original math remains unverified.')));
 const duplicate=await selectedDocumentNeighborhood(item.pool,item.owner,[chosen[0],item.hits.find(hit=>hit.page_number===3)!]);
 assert.equal(new Set(duplicate.map(hit=>hit.page_number)).size,duplicate.length);assert.equal(duplicate.length,4);
 await assert.rejects(selectedDocumentNeighborhood(item.pool,'foreign-owner',chosen),DocumentEvidenceChangedError);
 await assert.rejects(selectedDocumentNeighborhood(item.pool,item.owner,[{...chosen[0],course_id:'foreign-course'}]),DocumentEvidenceChangedError);
});

test('no new neighbor skips model work; empty and non-PDF sources never invent adjacent evidence',pg,async()=>{
 const item=await fixture(['Quartz actual selected page.','','']);
 const before=calls,result=await refineSelectedDocumentPages(item.pool,item.owner,'quartz',item.hits,5);
 assert.equal(calls,before);assert.equal(result.length,1);assert.equal(result[0].refinement_mode,'no-new-neighbors');
 assert.equal(result[0].refinement_candidate_count,1);assert.equal(result[0].body,item.hits[0].body);
 assert.equal(result[0].refined_from?.[0].evidence_id,item.hits[0].evidence_id);
 const text=await fixture(['Quartz selected paragraph.','Other original paragraph.'],'text/plain');
 assert.equal((await selectedDocumentNeighborhood(text.pool,text.owner,text.hits)).length,1);
 const timed=await fixture(['Quartz selected interval.','Original physical page.'],'application/pdf',true);
 assert.equal(timed.hits[0].content_kind,'time_segment');
 assert.equal((await selectedDocumentNeighborhood(timed.pool,timed.owner,timed.hits)).length,1);
 assert.equal(calls,before,'a PDF time-segment anchor cannot cause refinement provider work');
});

test('source changes during neighbor lookup are detected before a refinement provider request',pg,async()=>{
 const item=await fixture(['Quartz selected page.','Adjacent original page.']);let hidden=false;
 const racing=new Proxy(item.pool,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(...args:Parameters<Pool['query']>)=>{
  const result=await (target.query as (...values:unknown[])=>Promise<unknown>).apply(target,args);
  if(!hidden&&typeof args[0]==='string'&&args[0].includes('refinement:adjacent-evidence')){
   hidden=true;await kernel.hideParsedDocument(item.owner,item.document.id);
  }return result;
 };}}) as Pool;
 const before=calls;await assert.rejects(refineSelectedDocumentPages(racing,item.owner,'quartz',item.hits,5),DocumentEvidenceChangedError);
 assert.equal(hidden,true);assert.equal(calls,before);
});

test('a refinement selection retains actual neighbor evidence and uses its cache without repeated requests',pg,async()=>{
 const item=await fixture(['Quartz first-stage selection.','Complete original adjacent calculation.']);
 const selected=item.hits,attempts:string[]=[];let providerCalls=0;
 const guardedFetch=globalThis.fetch;
 const previousKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-never-sent';
 globalThis.fetch=async(_input,init)=>{
  providerCalls++;const request=JSON.parse(String(init?.body)),pages=JSON.parse(request.input[1].content).pages;
  assert.equal(request.text.format.name,'document_page_refinement');assert.equal(pages.length,2);
  assert.equal(pages[1].text,item.pages[1].text);
  return Response.json({output_text:JSON.stringify({orderedIds:['p1','p0']})});
 };
 try{
  await withDocumentRerankRunPolicy({dailyLimit:200,maxAttempts:1,beforeAttempt:async(identity,attempt)=>{
   assert.equal(attempt?.phase,'adjacent-refinement');attempts.push(identity);
  }},async()=>{
   const refined=await refineSelectedDocumentPages(item.pool,item.owner,'quartz calculation',selected,5);
   assert.equal(refined[0].page_number,2);assert.equal(refined[0].body,item.pages[1].text);assert.equal(refined.length,2);
   assert.equal(refined[0].refinement_mode,'adjacent-pages');assert.equal(refined[0].refinement_candidate_count,2);
   assert.deepEqual(refined[0].parser_warnings,['Original math remains unverified.']);
   await refineSelectedDocumentPages(item.pool,item.owner,'quartz calculation',selected,5);
   assert.equal(providerCalls,1);assert.equal(attempts.length,1);
   await kernel.hideParsedDocument(item.owner,item.document.id);
   await assert.rejects(refineSelectedDocumentPages(item.pool,item.owner,'quartz calculation',selected,5),DocumentEvidenceChangedError);
   assert.equal(providerCalls,1);
  });
 }finally{globalThis.fetch=guardedFetch;if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;}
});

test('the Kernel opt-in reuses initial/refinement caches and query vectors through the real hybrid search entry',pg,async()=>{
 const item=await fixture(Array.from({length:8},(_,index)=>'Quartz original calculation page '+(index+1)));
 const vector=Array.from({length:768},(_,index)=>index===0?1:0),[jobId]=await queueDocumentVectorJobs(item.pool,item.owner),job=(await claimIngestionJob(jobId))!;
 await runDocumentVectorJob(item.pool,job,{embed:async inputs=>inputs.map(()=>vector)});await finishIngestionJob(job.id,job.lease_token);
 const guardedFetch=globalThis.fetch,previousKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-never-sent';
 const phases:string[]=[],requests:string[]=[];let embeddingCalls=0,incomplete=false;
 globalThis.fetch=async(input,init)=>{
  const request=JSON.parse(String(init?.body));
  if(String(input).endsWith('/embeddings')){embeddingCalls++;return Response.json({data:[{index:0,embedding:vector}]});}
  const schema=request.text.format.name,pages=JSON.parse(request.input[1].content).pages;requests.push(schema);
  if(incomplete&&schema==='document_page_refinement')return Response.json({status:'incomplete'});
  const indices=schema==='document_page_refinement'?[5,4,3,2,1]:[0,1,2,3,4];
  return Response.json({output_text:JSON.stringify({orderedIds:indices.map(index=>pages[index].id)})});
 };
 const options={limit:5,semantic:true,hybrid:true,aiRerank:true,refineAdjacent:true,evidenceBody:'full-page' as const};
 try{
  await withDocumentRerankRunPolicy({dailyLimit:200,maxAttempts:1,beforeAttempt:async(_id,attempt)=>{phases.push(attempt!.phase);}},async()=>{
   const first=await kernel.searchDocumentText(item.owner,'quartz calculation',options);
   assert.equal(first.length,5);assert.equal(first[0].page_number,6);assert.equal(first[0].evidence_body,'full-page');
   assert.equal(first[0].refinement_candidate_count,6);assert.equal(first[0].refined_from?.length,5);
   const second=await kernel.searchDocumentText(item.owner,'quartz calculation',options);assert.deepEqual(second,first);
   assert.deepEqual(phases,['initial','adjacent-refinement']);assert.deepEqual(requests,['document_page_order','document_page_refinement']);
   assert.equal(embeddingCalls,1,'cached query vector is reused by subsequent stages and resumed calls');
   incomplete=true;
   const fallback=await kernel.searchDocumentText(item.owner,'quartz shifted calculation',options);
   assert.equal(fallback.length,5);assert.ok(fallback.every(hit=>hit.retrieval_mode==='keyword-fallback'));
   assert.ok(fallback.every(hit=>hit.degraded_reason==='ai:incomplete-output'));
   assert.equal(requests.filter(name=>name==='document_page_refinement').length,2,'failed refinement is not automatically retried');
  });
 }finally{globalThis.fetch=guardedFetch;if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;}
});
