import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import type{DocumentSearchOptions,DocumentTextHit}from'../lib/kernel/document-search.ts';
let providers=0;globalThis.fetch=async()=>{providers++;throw Error('Expanded route fixture forbids external calls');};
after(async()=>{try{assert.equal(providers,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),strip=(rows:DocumentTextHit[])=>rows.map(({classification_route_guard,...h})=>h);

test('website-style related retrieval preserves original expansion outside tag scope and keeps ambiguous seed order broad',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='expanded:'+uid,saved=process.env.KERNEL_CONTENT_TAG_ROUTING;
 const add=async(name:string,origin:string,bodies:string[],topic?:string,sourceOwner=owner)=>{
  const doc={id:hash(uid+name+sourceOwner),ownerId:sourceOwner,courseId:'',name:name+'.txt',hash:hash('raw'+uid+name+sourceOwner),mime:'text/plain',origin,originKey:uid+name};
  await kernel.ingestParsedDocument(doc,bodies.map((text,i)=>({locator:'page '+(i+1),pageNumber:i+1,text})),{parserVersion:'expanded-route-fixture'});
  if(topic){
   const row=(await kernelPool().query('SELECT d.current_version_id,v.source_version_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id WHERE d.id=$1',[doc.id])).rows[0];
   await kernel.recordDocumentClassification(sourceOwner,{documentId:doc.id,versionId:row.current_version_id,sourceVersionId:row.source_version_id,sourceHash:doc.hash,
    classifierId:'expanded/fixture',producerVersion:'v1',method:'manual',model:null,previousId:null,
    tags:[{facet:'topic',key:topic,confidence:1,evidence:{kind:'human-judgment'}}]},'test-admin','Isolated source expansion fixture');
  }return doc.id;
 };
 try{
  const lecture=await add('Lecture','canvas',['Quasarone. Consult “Supplement” for the clarification.'],'quasarone'),
   supplement=await add('Supplement','piazza',['This discussion supplies the clarification.']),
   foreign=await add('Supplement','piazza',['Foreign private source must never enter evidence.'],undefined,'foreign:'+uid);
  await add('Unrelated','gmail',['Unrelated material.']);
  const options:DocumentSearchOptions={semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,refineAdjacent:false,evidenceBody:'full-page',limit:14};
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';const baseline=await kernel.searchDocumentText(owner,'quasarone',options);
  assert.deepEqual(new Set(baseline.map(h=>h.document_id)),new Set([lecture,supplement]));
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';
  const guarded=await kernel.searchDocumentText(owner,'quasarone',options),receipt=guarded[0].classification_route_guard!;
  assert.deepEqual(strip(guarded),baseline,'Original order, scores, full-page text and source identities must match');
  assert.equal(receipt.effect,'expanded-lexical-narrowing');assert.equal(receipt.baselineExecuted,false);assert.equal(receipt.indexedMatchPages,1);
  assert.equal(receipt.scores,'reference-merge-rank');assert.deepEqual(receipt.plan.documentIds,[lecture]);
  assert.ok(guarded.some(h=>h.document_id===supplement),'Related unclassified source is read under original scope');
  assert.ok(guarded.every(h=>h.document_id!==foreign&&h.evidence_body==='full-page'));
  const explicit={...options,routingScope:{origins:['canvas']}};
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';const selected=await kernel.searchDocumentText(owner,'quasarone',explicit);
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';const bounded=await kernel.searchDocumentText(owner,'quasarone',explicit);
  assert.deepEqual(strip(bounded),selected);assert.deepEqual(bounded.map(h=>h.document_id),[lecture]);
  await assert.rejects(kernel.searchDocumentText(owner,'quasarone',{...options,evidenceBody:'invalid' as 'snippet'}),/evidence body/);
  await add('Many','canvas',['Twoseedcase brief.','Twoseedcase has a longer explanation without external source names.'],'twoseedcase');
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';const many=await kernel.searchDocumentText(owner,'twoseedcase',options);
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';const recovered=await kernel.searchDocumentText(owner,'twoseedcase',options);
  assert.deepEqual(strip(recovered),many);assert.equal(recovered[0].classification_route_guard!.reason,'reference-seed-order-unproven');
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=saved;}
});
