import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{searchDocumentText,documentSearchTerms,documentBroadSearchQuery,type DocumentTextHit,type DocumentSearchOptions}from'../lib/kernel/document-search.ts';
import{runGuardedClassification,classificationGuardAnswerObservation}from'../lib/kernel/classification-route-guard.ts';
let providers=0;globalThis.fetch=async()=>{providers++;throw Error('Guarded classification test forbids provider calls');};
after(async()=>{try{assert.equal(providers,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),strip=(hits:DocumentTextHit[])=>hits.map(({classification_route_guard,...h})=>h),
 tuple=(h:DocumentTextHit)=>JSON.stringify([h.document_id,h.page_number,h.source_version_id,h.evidence_id,h.source_hash]);

test('independent index coverage recovers wrong/unknown labels; narrow proof is bounded, isolated and rollback-safe',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='guard:'+uid,previous=process.env.KERNEL_CONTENT_TAG_ROUTING;
 const add=async(name:string,origin:string,topics:string[],bodies:string[],otherOwner=owner)=>{
  const doc={id:hash(uid+name),ownerId:otherOwner,courseId:'',name:name+'.txt',hash:hash('original'+uid+name),mime:'text/plain',origin,originKey:uid+name};
  await kernel.ingestParsedDocument(doc,bodies.map((text,i)=>({pageNumber:i+1,locator:'page '+(i+1),text})),{parserVersion:'guard-fixture'});
  const row=(await kernelPool().query('SELECT d.current_version_id,v.source_version_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id WHERE d.id=$1',[doc.id])).rows[0];
  if(topics.length)await kernel.recordDocumentClassification(otherOwner,{documentId:doc.id,versionId:row.current_version_id,sourceVersionId:row.source_version_id,sourceHash:doc.hash,
   classifierId:'guard/fixture',producerVersion:'v1',method:'manual',model:null,previousId:null,
   tags:topics.map(key=>({facet:'topic',key,confidence:1,evidence:{kind:'human-judgment'}}))},'test-admin','Isolated route fixture, not semantic ground truth');
  return doc.id;
 };
 try{
  const a=await add('tagged','canvas',['calculus','quasarone'],['Calculus derivative requirements. Quasarone explanation.','Quasarone second page.']),
   b=await add('wrong','piazza',['algebra'],['Calculus derivative supplementary explanation.']),u=await add('unknown','gmail',[],['Calculus derivative updated instructions.']);
  await add('foreign','canvas',['quasarone'],['Quasarone private.'],'foreign:'+uid);
  const opts:DocumentSearchOptions={semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,refineAdjacent:false,limit:14};
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';
  const baseline=await kernel.searchDocumentText(owner,'calculus derivative',opts),rareBaseline=await kernel.searchDocumentText(owner,'quasarone',opts),
   limitedBaseline=await kernel.searchDocumentText(owner,'quasarone',{...opts,limit:1});
  assert.deepEqual(new Set(baseline.map(h=>h.document_id)),new Set([a,b,u]));
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';
  const recovered=await kernel.searchDocumentText(owner,'calculus derivative',opts),r=recovered[0].classification_route_guard!;
  assert.deepEqual(strip(recovered),baseline);assert.equal(r.effect,'broad-fallback');assert.equal(r.reason,'outside-index-match');
  assert.equal(r.outsideMatch,true);assert.equal(r.branchExecuted,false);assert.equal(r.baselineExecuted,true);
  const rare=await kernel.searchDocumentText(owner,'quasarone',opts),proof=rare[0].classification_route_guard!;
  assert.deepEqual(new Set(rare.map(tuple)),new Set(rareBaseline.map(tuple)));assert.ok(rare.every(h=>h.document_id===a));
  assert.equal(proof.effect,'lexical-narrowing');assert.equal(proof.indexedMatchPages,2);assert.equal(proof.baselineExecuted,false);
  assert.equal(proof.snapshot,'repeatable-read');assert.equal(proof.semanticCoverage,'unassessed');assert.equal(proof.scores,'branch-scope-bm25');
  assert.equal(classificationGuardAnswerObservation(rare)?.receipts.length,1);
  const limited=await kernel.searchDocumentText(owner,'quasarone',{...opts,limit:1});
  assert.deepEqual(strip(limited),limitedBaseline);assert.equal(limited[0].classification_route_guard!.reason,'indexed-result-capacity');
  const scoped=await kernel.searchDocumentText(owner,'calculus derivative',{...opts,routingScope:{origins:['canvas']}});
  assert.ok(scoped.every(h=>h.document_id===a));assert.equal(scoped[0].classification_route_guard!.effect,'lexical-narrowing');
  const expanded=await kernel.searchDocumentText(owner,'calculus derivative',{...opts,relatedDocuments:true});
  assert.ok(expanded.every(h=>!h.classification_route_guard),'Do not narrow a path that requires cross-source expansion');
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';let failed=false;
  const rollback=await runGuardedClassification<DocumentTextHit,DocumentSearchOptions>(kernelPool(),owner,'quasarone',opts,
   {broadQuery:documentBroadSearchQuery(documentSearchTerms('quasarone').words),limit:14},async(db,o)=>{
    const state=(await db.query("SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation")).rows[0];
    assert.equal(state.ro,'on');assert.equal(state.isolation,'repeatable read');
    if(o.routingScope?.documentIds){failed=true;await db.query('SELECT * FROM deliberately_missing_guard_fixture_relation');}
    return searchDocumentText(db,owner,'quasarone',o);
   });
  assert.equal(failed,true);assert.deepEqual(strip(rollback),rareBaseline);
  assert.equal(rollback[0].classification_route_guard!.reason,'branch-search-failed');
  assert.equal((await kernelPool().query('SELECT 1 n')).rows[0].n,1,'Pool connection is usable after guarded recovery');
 }finally{if(previous===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=previous;}
});
