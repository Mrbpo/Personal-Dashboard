import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fuseLexicallySupportedAIRanks,DOCUMENT_LEXICAL_SUPPORT_THRESHOLD} from '../lib/kernel/document-search.ts';
import type {DocumentTextHit} from '../lib/kernel/document-search.ts';

const hit=(index:number,support?:number):DocumentTextHit=>({id:`snippet-${index}`,document_id:`document-${index}`,
  course_id:'',name:'Original.pdf',origin:'upload',origin_key:`source-${index}`,source_hash:`hash-${index}`,
  body:`Original evidence body ${index}`,locator:'第 1 页',page_number:1,evidence_id:`evidence-${index}`,
  source_version_id:`version-${index}`,parser_version:'original-parser',score:100-index,lexical_support:support});

test('one supported lexical page stays in top five while all remaining AI order and evidence survive',()=>{
 const lexical=Array.from({length:20},(_,index)=>hit(index,index===0?.6:.2));
 const ranked=[...lexical.slice(1),lexical[0]],snapshot=structuredClone(ranked);
 const fused=fuseLexicallySupportedAIRanks(lexical,ranked);
 assert.deepEqual(fused.slice(0,5).map(row=>row.id),[...ranked.slice(0,4),lexical[0]].map(row=>row.id));
 assert.deepEqual(fused.filter(row=>row.id!==lexical[0].id).map(row=>row.id),ranked.slice(0,-1).map(row=>row.id));
 assert.equal(new Set(fused.map(row=>row.id)).size,20);
 for(const [index,row] of fused.entries()){
  const original=lexical.find(page=>page.id===row.id)!;
  assert.deepEqual({...row,score:original.score},original);
  assert.equal(row.score,1/(index+1));
 }
 assert.deepEqual(ranked,snapshot,'the cached AI ordering inputs must not mutate');
 for(const limit of [1,4,5,12,20]){
  assert.deepEqual(fuseLexicallySupportedAIRanks(lexical,ranked,limit),fused.slice(0,limit),
   'kernel and library result limits must use the same fused prefix');
 }
});

test('a large keyword score cannot protect an unsupported hit; coverage selects the supported candidate',()=>{
 const lexical=Array.from({length:8},(_,index)=>hit(index,index===1?DOCUMENT_LEXICAL_SUPPORT_THRESHOLD:.2));
 lexical[0].score=1e9;
 const ranked=[...lexical.slice(2),lexical[1],lexical[0]];
 assert.equal(fuseLexicallySupportedAIRanks(lexical,ranked,5)[4].id,lexical[1].id);
 const unsupported=lexical.map(row=>({...row,lexical_support:undefined}));
 assert.deepEqual(fuseLexicallySupportedAIRanks(unsupported,ranked).map(row=>row.id),ranked.map(row=>row.id));
 for(const support of [NaN,Infinity,-1,1.1]){
  assert.deepEqual(fuseLexicallySupportedAIRanks(lexical.map(row=>({...row,lexical_support:support})),ranked)
   .map(row=>row.id),ranked.map(row=>row.id));
 }
});

test('already present support and small result sets preserve AI order; unvalidated or stale evidence cannot be inserted',()=>{
 const lexical=Array.from({length:8},(_,index)=>hit(index,index===0?.9:.1));
 const ranked=[lexical[1],lexical[0],...lexical.slice(2)];
 assert.deepEqual(fuseLexicallySupportedAIRanks(lexical,ranked).map(row=>row.id),ranked.map(row=>row.id));
 assert.deepEqual(fuseLexicallySupportedAIRanks(lexical,[lexical[1],lexical[0]],2).map(row=>row.id),
  [lexical[1].id,lexical[0].id]);
 const stale={...lexical[7],source_version_id:'old-source-version',lexical_support:1};
 const outside={...hit(50,1),score:1e9};
 const unprotected=lexical.map(row=>({...row,lexical_support:undefined}));
 assert.deepEqual(fuseLexicallySupportedAIRanks([outside,stale,...unprotected],ranked).map(row=>row.id),
  ranked.map(row=>row.id));
});

test('PostgreSQL support weights actual query coverage by IDF and excludes absent terms',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernel}=await import('../lib/kernel/service.ts');
 const {migrateKernel}=await import('../lib/kernel/db.ts');
 await migrateKernel();
 const owner=`support-${randomUUID()}`,id=`support-document-${randomUUID()}`;
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Independent support fixture.pdf',
  hash:id,mime:'application/pdf',origin:'upload',originKey:id},[
  {pageNumber:1,locator:'第 1 页',text:'Common quasar explanation.'},
  {pageNumber:2,locator:'第 2 页',text:'Common ordinary topic.'},
  {pageNumber:3,locator:'第 3 页',text:'Common additional topic.'},
 ],{parserVersion:'support-test',expectedPages:3});
 const hits=await kernel.searchDocumentText(owner,'common quasar absentzz',{limit:3});
 const withoutAbsent=await kernel.searchDocumentText(owner,'common quasar',{limit:3});
 assert.equal(hits.length,3);
 for(const row of hits){
  assert.equal(row.lexical_support,withoutAbsent.find(page=>page.id===row.id)?.lexical_support,
   'a term absent from the scoped collection cannot reduce measurable support');
 }
 const expectedCommonIdf=Math.log(1+.5/3.5),expectedRareIdf=Math.log(1+2.5/1.5);
 assert.equal(hits.find(row=>row.page_number===1)?.lexical_support,1);
 for(const row of hits.filter(page=>page.page_number!==1)){
  assert.ok(Math.abs(row.lexical_support!-expectedCommonIdf/(expectedCommonIdf+expectedRareIdf))<1e-12);
  assert.ok(row.lexical_support!<.5,'covering only the common term is weak support despite one of two words matching');
 }
 assert.deepEqual(await kernel.searchDocumentText('other-'+owner,'common quasar',{limit:3}),[]);
});
