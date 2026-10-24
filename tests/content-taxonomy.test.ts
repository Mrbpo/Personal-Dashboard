import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{classifyContentMetadata}from'../lib/kernel/content-tags.ts';
import{contentMetadataCatalog,CONTENT_METADATA_CATALOG_SHA256,CONTENT_METADATA_PRODUCER}from'../lib/kernel/content-taxonomy.ts';
import{contentTagQueryPlan}from'../lib/kernel/content-tag-routing.ts';
import{planClassificationBranch}from'../lib/kernel/classification-route-shadow.ts';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{METADATA_CLASSIFIER_ID}from'../lib/kernel/content-classification-ingestion.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('Metadata taxonomy checks forbid external calls');};
after(async()=>{try{assert.equal(fetches,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const cases=[
 ['Course Outline.pdf','course outline','syllabus','0c2dcccbcbf86dca71f63f546091cbfc4b99820a141f3bf185bdc39075c13ce4'],
 ['Discussion.txt','discussion','discussion','037f5d4088fec32c4e80ecc462c57bde215347d3c7ee8557e11dfba8f299f90c'],
 ['Lecture Transcript.txt','transcript','transcript','9402ccebe53b6533589be5cbddb5bd281fbc965fbd0b9b3e2e02f76339cb773e'],
 ['Syllabus.pdf','syllabus','syllabus','5b649d2730c8101dce96168e3c439f84fa42e32ea0a639245e3632b623312741'],
];
test('frozen old metadata snapshots remain byte-compatible while catalog rules resolve observed alias gaps',()=>{
 for(const[name,query,key,digest]of cases){
  const m={courseId:null,termId:null,origin:'upload',originKey:'frozen:'+name,name,mime:'text/plain'},old=classifyContentMetadata(m),
   next=classifyContentMetadata(m,'catalog-v2'),hint=contentTagQueryPlan(query);
  assert.equal(old.classificationSha256,digest,'Do not reinterpret old snapshot identities');
  assert.ok(next.tags.some(t=>t.facet==='document_type'&&t.key===key&&t.routingUse==='soft-only'&&t.witness.value===name));
  assert.ok(hint.hints.some(h=>h.facet==='document_type'&&h.key===key));
  assert.equal(next.producer,CONTENT_METADATA_PRODUCER);assert.equal(next.semanticVerified,false);assert.equal(next.filterAuthorization,false);
  assert.deepEqual(next.tags.filter(t=>t.facet!=='document_type'),old.tags.filter(t=>t.facet!=='document_type'));
 }
 assert.throws(()=>classifyContentMetadata({}as never,'unknown'as never),/Invalid metadata rule version/);
});
test('catalog revisions bind query aliases without mutable regex state, guessed subjects or filename course ownership',()=>{
 const catalog=contentMetadataCatalog(),q='🙂 Quercus course outline + Piazza discussion + 邮件 transcripts';
 assert.equal(hash(JSON.stringify(catalog)),CONTENT_METADATA_CATALOG_SHA256);
 const first=contentTagQueryPlan(q);assert.equal(first.catalogSha256,CONTENT_METADATA_CATALOG_SHA256);
 assert.ok(first.hints.every(h=>q.slice(h.start,h.end)===h.alias));
 for(let i=0;i<3;i++)assert.deepEqual(contentTagQueryPlan(q),first);
 catalog.sources[0].key='tampered';assert.equal(hash(JSON.stringify(contentMetadataCatalog())),CONTENT_METADATA_CATALOG_SHA256);
 const c=classifyContentMetadata({courseId:null,termId:null,origin:'upload',originKey:'file:unknown',
  name:'MATH Ｃｏｕｒｓｅ Outline 课程大纲.pdf',mime:'application/pdf'},'catalog-v2');
 assert.deepEqual(c.tags.filter(t=>t.facet==='document_type').map(t=>t.key),['syllabus']);
 assert.ok(c.unknownFacets.includes('course')&&c.unknownFacets.includes('topic'));
 assert.deepEqual(contentTagQueryPlan('discussional transcription canvaswork').hints,[]);
});
test('real ingestion upgrades rule provenance and routes current catalog labels while recovering untagged evidence and corrections',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='taxonomy:'+uid,savedTags=process.env.KERNEL_CONTENT_TAGS,savedRoute=process.env.KERNEL_CONTENT_TAG_ROUTING,
  doc=(key:string,name:string,origin='upload')=>({id:hash(uid+key),ownerId:owner,courseId:'',name,hash:hash('raw'+uid+key),mime:'text/plain',origin,originKey:'file:'+uid+key}),
  pages=(text:string)=>[{pageNumber:1,locator:'page 1',text}],parser={parserVersion:'taxonomy-metadata-fixture-v1'},
  a=doc('a','Course Outline.txt'),b=doc('b','Discussion.txt'),u=doc('u','Untitled.txt'),p=doc('p','Clarification.txt','piazza');
 try{
  process.env.KERNEL_CONTENT_TAGS='off';
  await kernel.ingestParsedDocument(a,pages('Gravity course requirements.'),parser);
  const head=(await kernelPool().query(`SELECT d.current_version_id "currentVersionId",v.source_version_id "sourceVersionId"
   FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id WHERE d.id=$1 AND d.owner_id=$2`,[a.id,owner])).rows[0];
  // A real old rule revision, not a changed historical fixture or fabricated excerpt.
  const old=await kernel.recordDocumentClassification(owner,{documentId:a.id,versionId:head.currentVersionId,
   sourceVersionId:head.sourceVersionId,sourceHash:a.hash,classifierId:METADATA_CLASSIFIER_ID,producerVersion:'source-metadata-rules-v1',
   method:'rule',model:null,previousId:null,tags:[{facet:'source',key:'upload',confidence:1,evidence:{kind:'source-metadata',field:'origin',value:'upload'}}]},
   'kernel:source-metadata','Automatic current-source metadata observations; semantic coverage unverified');
  process.env.KERNEL_CONTENT_TAGS='metadata-classifications-v1';
  await kernel.ingestParsedDocument(a,pages('Gravity course requirements.'),parser);
  const current=(await kernel.documentClassifications(owner,a.id))[0];
  assert.equal(current.previous_id,old.id);assert.equal(current.producer_version,CONTENT_METADATA_PRODUCER);
  assert.equal(Number((await kernelPool().query('SELECT count(*) n FROM document_content_classifications WHERE document_id=$1',[a.id])).rows[0].n),2);
  await kernel.ingestParsedDocument(b,pages('Advice about chemical safety.'),parser);
  await kernel.ingestParsedDocument(u,pages('Quantum optics notes.'),parser);
  const plan=await planClassificationBranch(kernelPool(),owner,'course outline gravity',{});
  assert.deepEqual(plan.documentIds,[a.id]);assert.equal(plan.catalogSha256,CONTENT_METADATA_CATALOG_SHA256);
  assert.deepEqual((await planClassificationBranch(kernelPool(),'foreign:'+owner,'course outline gravity',{})).documentIds,[]);
  assert.deepEqual((await planClassificationBranch(kernelPool(),owner,'discussion',{routingScope:{documentIds:[u.id]}})).documentIds,[]);
  const counts=await kernel.documentRoutingCounts(owner,{routingScope:{documentIds:plan.documentIds}});assert.equal(counts.eligibleDocuments,3);assert.equal(counts.routedDocuments,1);
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';
  const options={limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,refineAdjacent:false},
   narrow=await kernel.searchDocumentText(owner,'course outline gravity',options);
  assert.deepEqual(narrow.map(h=>h.document_id),[a.id]);assert.equal(narrow[0].classification_route_guard?.effect,'lexical-narrowing');
  // A relevant Piazza supplement has no syllabus label: independent lexical
  // evidence must defeat the proposed scope before scoring/releasing results.
  await kernel.ingestParsedDocument(p,pages('Gravity requirements were clarified today.'),parser);
  const expanded=await kernel.searchDocumentText(owner,'course outline gravity',options);
  assert.deepEqual(expanded.map(h=>h.document_id).sort(),[a.id,p.id].sort());
  assert.ok(expanded.every(h=>h.classification_route_guard?.effect==='broad-fallback'&&h.classification_route_guard.outsideMatch));
  const correction=await kernel.recordDocumentClassification(owner,{documentId:a.id,versionId:current.version_id,sourceVersionId:current.source_version_id,
   sourceHash:a.hash,classifierId:METADATA_CLASSIFIER_ID,producerVersion:'manual-v1',method:'manual',model:null,previousId:current.id,tags:[]},
   'fixture-admin','Withdraw filename classification');
  await kernel.ingestParsedDocument(a,pages('Gravity course requirements.'),parser);
  assert.equal((await kernel.documentClassifications(owner,a.id))[0].id,correction.id);
  assert.equal((await planClassificationBranch(kernelPool(),owner,'course outline gravity',{})).status,'broad');
  assert.deepEqual((await kernel.searchDocumentText(owner,'course outline gravity',options)).map(h=>h.document_id).sort(),[a.id,p.id].sort());
 }finally{
  if(savedTags===undefined)delete process.env.KERNEL_CONTENT_TAGS;else process.env.KERNEL_CONTENT_TAGS=savedTags;
  if(savedRoute===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=savedRoute;
 }
});
