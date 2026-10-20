import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,kernelTransaction,migrateKernel}from'../lib/kernel/db.ts';
import{contentTagIngestionMode}from'../lib/kernel/content-tags.ts';
import{recordIngestedContentClassification,METADATA_CLASSIFIER_ID}from'../lib/kernel/content-classification-ingestion.ts';
import{planClassificationBranch}from'../lib/kernel/classification-route-shadow.ts';
let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('Ingestion classification test forbids external fetch');};
after(async()=>{try{assert.equal(fetches,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

test('unified ingestion classification mode is explicit and default off',()=>{
 const saved=process.env.KERNEL_CONTENT_TAGS;
 try{delete process.env.KERNEL_CONTENT_TAGS;assert.equal(contentTagIngestionMode(),'off');
  process.env.KERNEL_CONTENT_TAGS='metadata-classifications-v1';assert.equal(contentTagIngestionMode(),'metadata-classifications-v1');
  process.env.KERNEL_CONTENT_TAGS='unknown';assert.throws(contentTagIngestionMode,/Invalid KERNEL_CONTENT_TAGS/);
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAGS;else process.env.KERNEL_CONTENT_TAGS=saved;}
});

test('ingestion publishes source-bound revisions to routing without duplicate legacy writes or undoing corrections',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='classification-ingest:'+uid,course='course:'+uid,term='term:'+uid,
  saved=process.env.KERNEL_CONTENT_TAGS,id=hash(uid),doc={id,ownerId:owner,courseId:course,name:'Syllabus.txt',hash:hash('raw'+uid),mime:'text/plain',origin:'canvas',originKey:'file:'+uid},
  pages=[{pageNumber:1,locator:'page 1',text:'The syllabus describes course requirements.'}],parser={parserVersion:'classification-ingest-plain-text-v1',extractionMethod:'plain-text'};
 const rows=()=>kernel.documentClassifications(owner,id),count=async()=>Number((await kernelPool().query('SELECT count(*) n FROM document_content_classifications WHERE document_id=$1',[id])).rows[0].n);
 try{
  process.env.KERNEL_CONTENT_TAGS='metadata-classifications-v1';
  await kernel.upsertCourse({id:course,name:'Synthetic course',course_code:'SYN101',term:{id:term,name:'Synthetic term'}});
  const storedTerm=(await kernelPool().query('SELECT term_id FROM courses WHERE id=$1',[course])).rows[0].term_id;
  await kernel.ingestParsedDocument(doc,pages,parser);const first=(await rows())[0];assert.ok(first);
  assert.equal(first.classifier_id,METADATA_CLASSIFIER_ID);assert.equal(first.method,'rule');assert.equal(first.filter_authorization,false);
  assert.equal(first.semantic_verified,false);assert.ok(first.unknown_facets.includes('topic'));
  assert.ok(first.assignments.some((t:{facet:string;key:string})=>t.facet==='course'&&t.key===course));
  assert.ok(first.assignments.some((t:{facet:string;key:string})=>t.facet==='document_type'&&t.key==='syllabus'));
  assert.equal((await kernel.documentMetadataTags(owner,id)).length,0,'New mode must not duplicate the legacy tag store');
  const plan=await planClassificationBranch(kernelPool(),owner,'syllabus requirements',{});assert.equal(plan.status,'candidate');assert.deepEqual(plan.documentIds,[id]);
  await kernel.ingestParsedDocument({...doc,name:'Display rename only.txt'},pages,parser);
  assert.equal(await count(),1);assert.equal((await rows())[0].id,first.id,'Immutable original metadata governs replay, not display rename');
  const nextTerm='next-term:'+uid;await kernel.upsertCourse({id:course,name:'Synthetic course',course_code:'SYN101',term:{id:nextTerm,name:'Next synthetic term'}});
  await kernel.ingestParsedDocument(doc,pages,parser);const changed=(await rows())[0];assert.notEqual(changed.id,first.id);assert.equal(changed.previous_id,first.id);assert.equal(await count(),2);
  await assert.rejects(kernelTransaction(async client=>{
   await client.query('UPDATE courses SET term_id=$2 WHERE id=$1',[course,storedTerm]);
   const pending=await recordIngestedContentClassification(client,owner,id,changed.version_id);assert.equal(pending.status,'recorded');throw Error('Deliberate atomic rollback');
  }),/Deliberate atomic rollback/);assert.equal(await count(),2);assert.equal((await rows())[0].id,changed.id);
  const identity={documentId:id,versionId:changed.version_id,sourceVersionId:changed.source_version_id,sourceHash:doc.hash,producerVersion:'fixture-v1',model:null};
  await kernel.recordDocumentClassification(owner,{...identity,classifierId:'manual/fixture',method:'manual',previousId:null,
   tags:[{facet:'topic',key:'human-topic',confidence:1,evidence:{kind:'human-judgment'}}]},'fixture-admin','Retain independent human classification');
  await kernel.ingestParsedDocument(doc,pages,parser);assert.equal((await rows()).length,2);assert.equal(await count(),3);
  const correction=await kernel.recordDocumentClassification(owner,{...identity,classifierId:METADATA_CLASSIFIER_ID,method:'manual',previousId:changed.id,tags:[]},'fixture-admin','Explicitly withdraw automatic labels');
  await kernel.ingestParsedDocument(doc,pages,parser);assert.equal(await count(),4);assert.ok((await rows()).some(r=>r.id===correction.id));
  assert.deepEqual(await kernelTransaction(c=>recordIngestedContentClassification(c,'wrong-owner',id,changed.version_id)),{status:'skipped',reason:'not-current-owned-source'});
  await kernel.ingestParsedDocument(doc,[{...pages[0],text:'New original source text for the next version.'}],parser);
  const current=(await rows())[0];assert.equal((await rows()).length,1);assert.notEqual(current.version_id,first.version_id);assert.equal(await count(),5);
  const newer={...doc,id:hash('newer'+uid),hash:hash('newer-raw'+uid),createdAt:'2099-01-01T00:00:00Z'};
  await kernel.ingestParsedDocument(newer,pages,parser);
  assert.deepEqual(await kernelTransaction(c=>recordIngestedContentClassification(c,owner,id,current.version_id)),{status:'skipped',reason:'not-current-owned-source'});
  assert.equal(await count(),5,'Superseded source replay must not create a current classification');
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAGS;else process.env.KERNEL_CONTENT_TAGS=saved;}
});
