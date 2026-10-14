import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {searchDocumentText,type DocumentSearchOptions} from '../lib/kernel/document-search.ts';
import {readFullDocumentEvidence,DocumentEvidenceChangedError} from '../lib/kernel/document-evidence.ts';

let externalCalls=0;
globalThis.fetch=async()=>{externalCalls++;throw new Error('Full evidence tests prohibit external calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const pg={skip:!process.env.KERNEL_DATABASE_URL};
const keyword={limit:1,semantic:false,aiRerank:false,hybrid:false};

test('full stored evidence restores distant text without changing ranking or parser warnings',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`full-owner-${tag}`,id=`full-source-${tag}`;
 const title='Full evidence fixture',body=`Quartz phase measurements. ${'Ordinary source prose. '.repeat(180)}Remote conclusion at the end.`;
 const warnings=['Original equation transcription remains unverified.'];
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:title,hash:tag,mime:'text/plain',origin:'full-evidence-test',originKey:id},
  [{pageNumber:1,locator:'section:2:paragraph:1',text:body}],{parserVersion:'full-evidence-test',warnings});
 const sourceHint={selectedDocumentTitle:title};
 const preview=await kernel.searchDocumentText(owner,'quartz phase',{...keyword,sourceHint});
 const full=await kernel.searchDocumentText(owner,'quartz phase',{...keyword,sourceHint,evidenceBody:'full-page'});
 assert.equal(preview.length,1);assert.equal(full.length,1);
 assert.ok(preview[0].body.length<=1600);assert.ok(!preview[0].body.includes('Remote conclusion'));
 assert.equal(full[0].body,body);assert.equal(full[0].evidence_body,'full-page');
 assert.equal(full[0].retrieval_scope,'selected-title-scoped');assert.deepEqual(full[0].parser_warnings,warnings);
 const identity=(hit:typeof full[number])=>[hit.document_id,hit.page_number,hit.locator,hit.evidence_id,
  hit.source_version_id,hit.source_hash,hit.parser_version,hit.score,hit.retrieval_mode,hit.lexical_support];
 assert.deepEqual(identity(full[0]),identity(preview[0]));
 assert.match(full[0].id,/^pg:[^:]+:1$/);assert.notEqual(full[0].id,preview[0].id);
 await assert.rejects(readFullDocumentEvidence(kernelPool(),'other-'+owner,preview),DocumentEvidenceChangedError);
});

test('a source hidden between ranking and body lookup fails instead of publishing a stale preview',pg,async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`full-race-${tag}`,id=`full-race-source-${tag}`;
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Race fixture',hash:tag,mime:'text/plain',origin:'full-evidence-test',originKey:id},
  [{pageNumber:1,locator:'page:1',text:'Quartz phase current source.'}],{parserVersion:'full-evidence-test'});
 const preview=await kernel.searchDocumentText(owner,'quartz phase',keyword);
 const pool=kernelPool();let hid=false;
 const concurrentPool=new Proxy(pool,{get(target,key){
  if(key!=='query')return Reflect.get(target,key);
  return async(...args:Parameters<Pool['query']>)=>{
   if(!hid){hid=true;await kernel.hideParsedDocument(owner,id);}
   return (target.query as (...values:unknown[])=>Promise<unknown>).apply(target,args);
  };
 }}) as Pool;
 await assert.rejects(readFullDocumentEvidence(concurrentPool,owner,preview),
  (error:unknown)=>error instanceof DocumentEvidenceChangedError&&error.code==='DOCUMENT_EVIDENCE_CHANGED');
 assert.equal(hid,true);
});

test('invalid full-evidence modes fail before querying or invoking models',async()=>{
 let queries=0;const pool={query:async()=>{queries++;throw new Error('Unexpected query');}} as unknown as Pool;
 await assert.rejects(searchDocumentText(pool,'owner','quartz phase',
  {evidenceBody:'all-sources'} as unknown as DocumentSearchOptions),/Invalid document evidence body mode/);
 assert.equal(queries,0);assert.deepEqual(await readFullDocumentEvidence(pool,'owner',[]),[]);
});
