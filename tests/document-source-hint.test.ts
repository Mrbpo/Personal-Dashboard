import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {searchDocumentText} from '../lib/kernel/document-search.ts';
import {DocumentSourceResolutionError} from '../lib/kernel/document-source.ts';

let externalCalls=0;
globalThis.fetch=async()=>{externalCalls++;throw new Error('Source hint fixture tests prohibit external calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const pg={skip:!process.env.KERNEL_DATABASE_URL};
const keyword={limit:14,semantic:false,aiRerank:false,hybrid:false,relatedDocuments:true};
const errorCode=(code:string)=>(error:unknown)=>error instanceof DocumentSourceResolutionError&&error.code===code;
const ingest=async(id:string,ownerId:string,name:string,body:string,courseId='',originKey=id,createdAt?:string)=>
 kernel.ingestParsedDocument({id,ownerId,courseId,name,hash:randomUUID(),mime:'text/plain',origin:'source-hint-test',originKey,createdAt},
  [{pageNumber:1,locator:'paragraph:0',text:body}],{parserVersion:'source-hint-test'});

test('selected title cannot resolve another owner, another course, hidden source, or unknown title',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`source-owner-${tag}`,course=`source-course-${tag}`,title='Exact selected handout';
 await kernel.upsertCourse({id:course,name:'Source hint fixture',course_code:'SOURCE'});
 const foreign=`foreign-${tag}`,hidden=`hidden-${tag}`,otherCourse=`other-course-${tag}`;
 await ingest(foreign,'other-'+owner,title,'Quartz phase evidence.',course);
 await ingest(hidden,owner,title,'Quartz phase hidden evidence.',course);await kernel.hideParsedDocument(owner,hidden);
 await ingest(otherCourse,owner,title,'Quartz phase unselected course evidence.');
 assert.equal((await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title},{courseId:course})).status,'not-found');
 await assert.rejects(kernel.searchDocumentText(owner,'Quartz phase',{...keyword,courseId:course,
  sourceHint:{selectedDocumentTitle:title}}),errorCode('DOCUMENT_SOURCE_NOT_FOUND'));
 await assert.rejects(kernel.searchDocumentText(owner,'Quartz phase',{...keyword,
  sourceHint:{selectedDocumentTitle:'Unknown title'}}),errorCode('DOCUMENT_SOURCE_NOT_FOUND'));
 const id=`selected-${tag}`;await ingest(id,owner,title,'Quartz phase visible evidence.',course);
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title},{courseId:course});
 assert.equal(resolution.status,'resolved');if(resolution.status==='resolved')assert.equal(resolution.document.documentId,id);
});

test('superseded origins and equal-time older IDs cannot resolve by their former title',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`source-newest-${tag}`,originKey=`origin-${tag}`;
 const old=`a-${tag}`,current=`z-${tag}`,at='2026-01-01T12:00:00.000Z';
 await ingest(old,owner,'Old exact title','Quartz phase obsolete evidence.','',originKey,at);
 await ingest(current,owner,'Current exact title','Quartz phase current evidence.','',originKey,at);
 await assert.rejects(kernel.searchDocumentText(owner,'Quartz phase',{...keyword,
  sourceHint:{selectedDocumentTitle:'Old exact title'}}),errorCode('DOCUMENT_SOURCE_NOT_FOUND'));
 const hits=await kernel.searchDocumentText(owner,'Quartz phase',{...keyword,sourceHint:{selectedDocumentTitle:'Current exact title'}});
 assert.ok(hits.length);assert.ok(hits.every(hit=>hit.document_id===current));
});

test('two distinct current NFKC-equivalent titles are explicit ambiguity, never a first match',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`source-ambiguous-${tag}`,first=`first-${tag}`,second=`second-${tag}`;
 await ingest(first,owner,'Finite ﬁeld guide','Quartz phase first evidence.');
 await ingest(second,owner,'Finite field guide','Quartz phase second evidence.');
 const hint={selectedDocumentTitle:'Finite field guide'},resolution=await kernel.resolveDocumentSource(owner,hint);
 assert.equal(resolution.status,'ambiguous');if(resolution.status==='ambiguous')assert.equal(resolution.matches.length,2);
 await assert.rejects(kernel.searchDocumentText(owner,'Quartz phase',{...keyword,sourceHint:hint}),errorCode('DOCUMENT_SOURCE_AMBIGUOUS'));
 const global=await kernel.searchDocumentText(owner,'Quartz phase',keyword);
 assert.deepEqual(new Set(global.map(hit=>hit.document_id)),new Set([first,second]));
 assert.ok(global.every(hit=>hit.retrieval_scope===undefined));
});

test('NFKC source metadata scopes the unchanged relevance query without adding title words',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`source-separate-${tag}`,selected=`selected-${tag}`,other=`other-${tag}`;
 const title='Finite ﬁeld guide',query='quartz phase';
 await kernel.ingestParsedDocument({id:selected,ownerId:owner,courseId:'',name:title,hash:tag,mime:'text/plain',origin:'source-hint-test',originKey:selected},[
  {pageNumber:1,locator:'title-noise',text:'Finite field guide finite field guide.'},
  {pageNumber:2,locator:'evidence',text:'Quartz phase measurements are reproducible.'}],{parserVersion:'source-hint-test'});
 await ingest(other,owner,'Different title','Quartz phase unrelated-source measurements.');
 const hint={selectedDocumentTitle:'Finite field guide'};
 const resolved=await kernel.resolveDocumentSource(owner,hint);
 assert.equal(resolved.status,'resolved');if(resolved.status==='resolved')assert.equal(resolved.document.documentId,selected);
 const hits=await kernel.searchDocumentText(owner,query,{...keyword,strict:true,sourceHint:hint});
 const direct=await kernel.searchDocumentText(owner,query,{...keyword,strict:true,documentId:selected});
 assert.deepEqual(hits.map(({retrieval_scope,...hit})=>{assert.equal(retrieval_scope,'selected-title-scoped');return hit;}),direct);
 assert.deepEqual(hits.map(hit=>hit.locator),['evidence']);
 await assert.rejects(kernel.searchDocumentText(owner,query,{...keyword,sourceHint:hint,documentId:other}),errorCode('DOCUMENT_SOURCE_SCOPE_CONFLICT'));
 assert.equal((await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'finite field guide'})).status,'not-found','case remains exact');
 assert.equal((await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Finite field guide.txt'})).status,'not-found','no inferred aliases');
});

test('visibility changes and ABA replay cannot publish obsolete selected-source hits',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`source-race-${tag}`,id=`source-${tag}`,title='Current race fixture';
 await ingest(id,owner,title,'Quartz phase current evidence.');
 const pool=kernelPool();let hid=false;
 const concurrentPool=new Proxy(pool,{get(target,key){
  if(key!=='query')return Reflect.get(target,key);
  return async(...args:Parameters<Pool['query']>)=>{
   const result=await (target.query as (...values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>) .apply(target,args);
   if(!hid&&result.rows.some(row=>row.document_id===id&&row.evidence_id)){
    hid=true;await kernel.hideParsedDocument(owner,id);
   }
   return result;
  };
 }}) as Pool;
 await assert.rejects(searchDocumentText(concurrentPool,owner,'Quartz phase',{...keyword,sourceHint:{selectedDocumentTitle:title}}),
  errorCode('DOCUMENT_SOURCE_CHANGED'));
 assert.equal(hid,true);
 // Both resolver reads see v1, while the query observed v2 in between. A replay
 // restoring v1 must not make v2's evidence publishable under the selected scope.
 const identity={documentId:'selected',title:'Exact visible title',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:'raw-sha'};
 const stale={id:'pg:v2:1',document_id:'selected',course_id:'',name:identity.title,origin:'fixture',origin_key:'selected',
  source_hash:'raw-sha',body:'Quartz phase newer version.',locator:'page1',page_number:1,evidence_id:'e2',source_version_id:'s2',
  parser_version:'fixture',score:1,lexical_support:1};
 let calls=0;
 const replayPool={query:async()=>{calls++;return {rows:calls===2?[stale]:[identity]};}} as unknown as Pool;
 await assert.rejects(searchDocumentText(replayPool,'owner','Quartz phase',{...keyword,relatedDocuments:false,
  sourceHint:{selectedDocumentTitle:identity.title}}),errorCode('DOCUMENT_SOURCE_CHANGED'));
 assert.equal(calls,3);
});
