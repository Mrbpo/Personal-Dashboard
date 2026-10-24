import{test,after}from'node:test';import assert from'node:assert/strict';import{createHash,randomUUID}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{validateStoredContentClassification}from'../lib/kernel/content-classifications.ts';
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Controlled topic tests forbid provider fetch');};
after(async()=>{try{assert.equal(calls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

test('controlled topic proposals persist source fragments, feed routing and preserve vocabulary/correction/replay boundaries',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='topic-owner:'+uid,saved=process.env.KERNEL_CONTENT_TAG_ROUTING;
 const add=async(name:string,text:string,who=owner,more:string[]=[])=>{
  const doc={id:sha(uid+name+who),ownerId:who,courseId:'',name,hash:sha([text,...more].join('\n')),origin:'upload',originKey:uid+name,mime:'text/plain'};
  await kernel.ingestParsedDocument(doc,[text,...more].map((text,i)=>({pageNumber:i+1,locator:'page '+(i+1),text})),{parserVersion:'topic-plain-text-fixture-v1',extractionMethod:'plain-text'});return doc;
 };
 const classify=async(doc:Awaited<ReturnType<typeof add>>,key:string,previousId:string|null=null,classifierId='manual/topics')=>{
  const row=(await kernelPool().query('SELECT d.current_version_id,v.source_version_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id WHERE d.id=$1',[doc.id])).rows[0];
  return kernel.recordDocumentClassification(owner,{documentId:doc.id,versionId:row.current_version_id,sourceVersionId:row.source_version_id,sourceHash:doc.hash,
   classifierId,producerVersion:'fixture-v1',method:'manual',model:null,previousId,tags:[{facet:'topic',key,confidence:1,evidence:{kind:'human-judgment'}}]},'fixture-admin','Explicit controlled topic seed');
 };
 try{
  const target=await add('New Notes.txt','The integral of x is x squared divided by two. Quasartopic is discussed.',owner,['Second page about integrals.']),
   seed=await add('Human Seed.txt','Reviewed seed document.');
  assert.equal((await kernel.prepareDocumentTopics(owner,target.id)).status,'unavailable','No invented vocabulary without a manual seed');
  const seedRevision=await classify(seed,'calculus'),prepared=await kernel.prepareDocumentTopics(owner,target.id,[1]);
  assert.equal(prepared.status,'ready');if(prepared.status==='ready'){
   assert.equal(prepared.packet.version,'manual-vocabulary-topic-proposal-v3');
   assert.equal(Object.hasOwn(prepared.packet,'taxonomyRevisionId'),false,'No registry retains the original packet shape');
  }
  assert.equal(prepared.status,'ready');if(prepared.status!=='ready')throw Error('Missing packet');const packet=prepared.packet;
  assert.deepEqual(packet.labels,[{id:'t0',key:'calculus'}]);assert.deepEqual(packet.vocabularyRevisionIds,[seedRevision.id]);
  const raw=(labels:unknown[],model='gpt-5.4-mini')=>JSON.stringify({status:'completed',model,usage:{input_tokens:100,output_tokens:50},output_text:JSON.stringify({labels})}),
   labels=[{labelId:'t0',quoteUnitId:packet.quoteUnits.find(q=>q.text.includes('The integral of x'))!.id}],response=raw(labels);
  await assert.rejects(kernel.importDocumentTopics(owner,packet,raw([{...labels[0],labelId:'invented'}]),'fixture-admin','Apply proposal'),/Unknown topic/);
  await assert.rejects(kernel.importDocumentTopics(owner,packet,raw([{...labels[0],quoteUnitId:'invented'}]),'fixture-admin','Apply proposal'),/Unknown topic/);
  await assert.rejects(kernel.importDocumentTopics(owner,packet,raw([{labelId:'t0',unitId:'p0',quote:'The integral of x'}]),'fixture-admin','Apply proposal'),/Invalid topic binding/);
  await assert.rejects(kernel.importDocumentTopics(owner,packet,raw(labels,'other-model'),'fixture-admin','Apply proposal'),/unsupported model/);
  await assert.rejects(kernel.importDocumentTopics('foreign-owner',packet,response,'fixture-admin','Apply proposal'),/packet changed/);
  const tampered=structuredClone(packet);tampered.labels[0].key='new-topic';
  await assert.rejects(kernel.importDocumentTopics(owner,tampered,response,'fixture-admin','Apply proposal'),/packet changed/);
  assert.equal((await kernel.documentClassifications(owner,target.id)).length,0,'Rejected candidates must not write');
  const imported=await kernel.importDocumentTopics(owner,packet,response,'fixture-admin','Apply proposal');assert.equal(imported.current,true);
  const rows=await kernel.documentClassifications(owner,target.id),classification=validateStoredContentClassification(rows[0]);
  assert.equal(classification.method,'model');assert.equal(classification.tags[0].key,'calculus');assert.equal(classification.tags[0].evidence.kind,'page');
  assert.equal((rows[0].assignments as any[])[0].scope.kind,'fragment');assert.equal((rows[0].assignments as any[])[0].semanticVerified,false);
  const audit=JSON.parse(String(rows[0].reason));assert.equal(audit.rawResponseSha256,sha(response));assert.equal(audit.transport,'administrator-imported-output');
  assert.deepEqual(audit.vocabularyRevisionIds,[seedRevision.id]);
  const replay=await kernel.importDocumentTopics(owner,packet,response,'fixture-admin','Apply proposal');assert.deepEqual(replay,{...imported,replayed:true});
  const next=await kernel.prepareDocumentTopics(owner,target.id);assert.equal(next.status,'ready');
  if(next.status==='ready')assert.deepEqual(next.packet.vocabularyRevisionIds,[seedRevision.id],'Model revisions must not seed vocabulary');
  const page2=await kernel.prepareDocumentTopics(owner,target.id,[2]);assert.equal(page2.status,'ready');
  if(page2.status==='ready'){
   assert.notEqual(page2.packet.classifierId,packet.classifierId);
   await kernel.importDocumentTopics(owner,page2.packet,raw([{labelId:'t0',quoteUnitId:page2.packet.quoteUnits[0].id}]),'fixture-admin','Other page proposal');
   assert.equal((await kernel.documentClassifications(owner,target.id)).length,2,'A second page must not replace earlier fragment labels');
  }
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';
  const options={semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,refineAdjacent:false,limit:14},
   route=await kernel.searchDocumentText(owner,'calculus quasartopic',options);
  assert.deepEqual(route.map(r=>r.document_id),[target.id]);assert.equal(route[0].classification_route_guard!.effect,'lexical-narrowing');
  assert.ok(route[0].classification_route_guard!.plan.classificationIds.includes(imported.id),'The existing route actually consumes the imported proposal');
  const unclassified=await add('Unclassified Piazza.txt','Quasartopic supplement without a topic tag.');
  const recovered=await kernel.searchDocumentText(owner,'calculus quasartopic',options);
  assert.equal(recovered[0].classification_route_guard!.effect,'broad-fallback');assert.ok(recovered.some(r=>r.document_id===unclassified.id));
  const changed=await classify(seed,'linear algebra',seedRevision.id);
  if(next.status==='ready')await assert.rejects(kernel.importDocumentTopics(owner,next.packet,response,'fixture-admin','New proposal'),/vocabulary or correction head changed/);
  await classify(target,'analysis',imported.id,packet.classifierId);
  assert.equal((await kernel.prepareDocumentTopics(owner,target.id)).status,'unavailable','Manual producer correction blocks automatic overwriting');
  assert.equal((await kernel.prepareDocumentTopics(owner,target.id,[1,2])).status,'unavailable','A broader overlapping batch must not bypass a manual correction');
  assert.equal((await kernel.prepareDocumentTopics(owner,target.id,[2])).status,'ready','A non-overlapping page remains independently classifiable');
  const historicalReplay=await kernel.importDocumentTopics(owner,packet,response,'fixture-admin','Apply proposal');assert.equal(historicalReplay.replayed,true);assert.equal(historicalReplay.current,false);
  assert.notEqual((await kernel.documentClassifications(owner,target.id))[0].id,imported.id);
  for(let i=0;i<17;i++){const duplicate=await add('Repeated manual seed '+i,'Repeated manually reviewed topic seed.');await classify(duplicate,'calculus');}
  const deduped=await kernel.prepareDocumentTopics(owner,unclassified.id);assert.equal(deduped.status,'ready','Repeated labels across many reviewed documents must not exhaust the label catalog');
  if(deduped.status==='ready'){assert.equal(deduped.packet.labels.length,3);assert.ok(deduped.packet.vocabularyRevisionIds.length<=3);}
  const repeated=await add('Repeated source names.txt','Repeated name.\n\n'+'x'.repeat(1250)+'\n\nRepeated name.'),ambiguous=await kernel.prepareDocumentTopics(owner,repeated.id);
  assert.equal(ambiguous.status,'ready');if(ambiguous.status==='ready'){
   const occurrences=ambiguous.packet.quoteUnits.filter(q=>q.text.includes('Repeated name.'));assert.equal(occurrences.length,2);
   assert.notEqual(occurrences[0].id,occurrences[1].id);const chosen=occurrences[1],label=ambiguous.packet.labels.find(l=>l.key==='calculus')!;
   const result=await kernel.importDocumentTopics(owner,ambiguous.packet,raw([{labelId:label.id,quoteUnitId:chosen.id}]),'fixture-admin','Select the actual second source fragment');
   const stored=(await kernel.documentClassifications(owner,repeated.id)).find(r=>r.id===result.id)!;
   assert.equal((stored.assignments as any[])[0].witness.startUtf16,chosen.startUtf16);assert.ok(chosen.startUtf16>0);
   assert.equal((stored.assignments as any[])[0].witness.text,chosen.text,'Do not relocate repeated words to the first match');
  }
  await kernel.ingestParsedDocument(target,[{pageNumber:1,locator:'page 1',text:'New source text.'}],{parserVersion:'topic-plain-text-fixture-v2',extractionMethod:'plain-text'});
  await assert.rejects(kernel.importDocumentTopics(owner,packet,response,'fixture-admin','Apply proposal'),/no longer current/);
  assert.ok(changed.id);
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=saved;}
});
