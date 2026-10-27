import{test,after}from'node:test';import assert from'node:assert/strict';import{createHash,randomUUID}from'node:crypto';
import{documentSearchTerms,prepareClassificationQuery}from'../lib/kernel/document-search.ts';
import{contentTaxonomyQueryAliases}from'../lib/kernel/content-taxonomy-registry.ts';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Alias recall checks forbid model/embedding calls');};
after(async()=>{try{assert.equal(calls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),entries=[{facet:'topic' as const,key:'likelihood',aliases:['最大似然','maximum likelihood','ML']},
 {facet:'topic' as const,key:'machine-learning',aliases:['ML','机器学习']}],
 registry={revisionId:'a'.repeat(64),previousId:null,entries,version:'academic-topic-taxonomy-v1',actor:'fixture',reason:'Control',semanticVerified:false as const,filterAuthorization:false as const};
test('bounded alias terms extend both languages without replacing a long original question or silently truncating additions',()=>{
 const aliases=contentTaxonomyQueryAliases('最大似然',registry),short=prepareClassificationQuery('最大似然',aliases);
 assert.equal(short.query,'最大似然');assert.equal(short.expansion?.status,'expanded');assert.ok(short.terms!.includes('likelihood'));
 assert.equal(aliases!.omittedAmbiguousAliases,1);assert.ok(!short.terms!.includes('ml'),'A clear topic must not introduce another concept through an ambiguous alternate acronym');
 const ambiguous=prepareClassificationQuery('ML',contentTaxonomyQueryAliases('ML',registry));
 assert.ok(['likelihood','machine','learning'].every(w=>ambiguous.terms!.includes(w)),'An actually ambiguous query keeps both concepts');
 assert.ok(documentSearchTerms(short.query).words.every(w=>short.terms!.includes(w)));
 const long='最大似然 '+Array.from({length:40},(_,i)=>'word'+String.fromCharCode(97+Math.floor(i/26))+String.fromCharCode(97+i%26)).join(' '),
  original=documentSearchTerms(long),expanded=prepareClassificationQuery(long,aliases);
 assert.equal(original.words.length,40);assert.equal(expanded.query,long);assert.equal(expanded.expansion?.status,'expanded');
 assert.ok(expanded.terms!.length>40&&expanded.terms!.length<=80);assert.ok(original.words.every(w=>expanded.terms!.includes(w)));
 const capacity=prepareClassificationQuery('最大似然',{...aliases!,phrases:[Array.from({length:41},(_,i)=>'alias'+String.fromCharCode(97+Math.floor(i/26))+String.fromCharCode(97+i%26)).join(' ')]});
 assert.equal(capacity.expansion?.status,'unavailable');assert.equal(capacity.terms,undefined);assert.equal(capacity.query,'最大似然');
 assert.deepEqual(prepareClassificationQuery('x^2 + y',undefined),{query:'x^2 + y',broadQuery:documentSearchTerms('x^2 + y').words.map(w=>'"'+w+'"').join(' OR ')});
});
test('actual lexical retrieval uses aliases, protects untagged/wrong-tag sources and preserves owner/current/explicit scope',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='alias-recall:'+uid,course='alias-course:'+uid,otherCourse='alias-other:'+uid,
  saved=process.env.KERNEL_CONTENT_TAG_ROUTING,options={limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,refineAdjacent:false,evidenceBody:'full-page' as const};
 const add=async(key:string,text:string,c=course,who=owner,origin='upload')=>{
  const doc={id:sha(uid+key+who),ownerId:who,courseId:c,name:key+'.txt',hash:sha(text),mime:'text/plain',origin,originKey:uid+key};
  await kernel.ingestParsedDocument(doc,[{pageNumber:1,locator:'page 1',text}],{parserVersion:'alias-recall-fixture-v1'});return doc;
 };
 const tag=async(doc:Awaited<ReturnType<typeof add>>,key='likelihood')=>{
  const row=(await kernelPool().query(`SELECT v.id,v.source_version_id,p.body,p.evidence_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
   JOIN document_text_pages p ON p.version_id=v.id WHERE d.id=$1 AND d.owner_id=$2`,[doc.id,owner])).rows[0];
  return kernel.recordDocumentClassification(owner,{documentId:doc.id,versionId:row.id,sourceVersionId:row.source_version_id,sourceHash:doc.hash,
   classifierId:'manual/recall-fixture',producerVersion:'fixture-v1',method:'manual',model:null,previousId:null,
   tags:[{facet:'topic',key,confidence:1,evidence:{kind:'page',pageNumber:1,evidenceId:row.evidence_id,startUtf16:0,endUtf16:row.body.length,text:row.body}}]},
   'fixture-admin','Explicit fallible recall fixture');
 };
 try{
  await kernel.upsertCourse({id:course,name:'Synthetic maths',course_code:'SYN101'});await kernel.upsertCourse({id:otherCourse,name:'Other course',course_code:'SYN102'});
  const taxonomy=await kernel.recordContentTaxonomy(owner,{previousId:null,entries},'fixture-admin','Approved bilingual retrieval fixture'),
   a=await add('notes','Likelihood estimates use probabilities.');await tag(a);
  await add('chemistry','Atoms and bonds describe chemical structure.',otherCourse);
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';assert.deepEqual(await kernel.searchDocumentText(owner,'最大似然',options),[]);
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-guarded-lexical-v1';
  const first=await kernel.searchDocumentText(owner,'最大似然',options);assert.deepEqual(first.map(h=>h.document_id),[a.id]);
  assert.equal(first[0].body,'Likelihood estimates use probabilities.');assert.equal(first[0].evidence_body,'full-page');
  assert.equal(first[0].classification_route_guard?.baseEffect,'lexical-narrowing');assert.equal(first[0].classification_route_guard?.queryExpansion?.status,'expanded');
  assert.equal(first[0].classification_route_guard?.queryExpansion?.originalQuerySha256,sha('最大似然'));
  assert.equal(first[0].classification_route_guard?.plan.taxonomyRevisionId,taxonomy.id);
  const longQuestion='请根据资料说明最大似然估计的基本原理、适用条件、学习过程中需要考虑的概率问题，以及这些条件怎样影响参数变化与模型选择。';
  assert.equal(documentSearchTerms(longQuestion).words.length,40);
  const long=await kernel.searchDocumentText(owner,longQuestion,options);assert.deepEqual(long.map(h=>h.document_id),[a.id]);
  assert.ok(long[0].classification_route_guard!.queryExpansion!.expandedTermCount>40,'English recall must survive a normal long Chinese question');
  assert.deepEqual(await kernel.searchDocumentText(owner,'最大似然',{...options,strict:true}),[],'Strict matching is not silently translated');
  const b=await add('piazza','Maximum likelihood requirements were clarified today.',course,owner,'piazza'),
   c=await add('other-maths','Maximum likelihood in another course.',otherCourse),
   foreign=await add('foreign','Maximum likelihood belongs to another owner.',course,'foreign:'+owner);
  const broad=await kernel.searchDocumentText(owner,'最大似然',options);
  assert.deepEqual(broad.map(h=>h.document_id).sort(),[a.id,b.id,c.id].sort());
  assert.ok(broad.every(h=>(h.classification_route_guard?.baseEffect??h.classification_route_guard?.effect)==='broad-fallback'&&h.classification_route_guard?.outsideMatch),
   'The expanded index guard must detect untagged English evidence outside the proposed files');
  assert.deepEqual((await kernel.searchDocumentText(owner,'最大似然',{...options,routingScope:{courseIds:[course]}})).map(h=>h.document_id).sort(),[a.id,b.id].sort());
  assert.deepEqual((await kernel.searchDocumentText(owner,'最大似然',{...options,routingScope:{documentIds:[a.id]}})).map(h=>h.document_id),[a.id]);
  assert.deepEqual((await kernel.searchDocumentText('foreign:'+owner,'likelihood',options)).map(h=>h.document_id),[foreign.id]);
  const d=await add('ml','ML means machine learning in these notes.');await tag(d,'machine-learning');
  assert.deepEqual((await kernel.searchDocumentText(owner,'ML',options)).map(h=>h.document_id).sort(),[a.id,b.id,c.id,d.id].sort());
  assert.deepEqual((await kernel.searchDocumentText(owner,'最大似然',options)).map(h=>h.document_id).sort(),[a.id,b.id,c.id].sort());
  // An incorrect current tag must not manufacture a match or exclude the
  // correct untagged evidence. Old version labels must not become current.
  const changed={...a,id:sha(uid+'notes-new-capture'),hash:sha('Atoms only.'),createdAt:new Date().toISOString()};
  await kernel.ingestParsedDocument(changed,[{pageNumber:1,locator:'page 1',text:'Atoms only.'}],{parserVersion:'alias-recall-fixture-v1'});await tag(changed);
  const wrong=await kernel.searchDocumentText(owner,'最大似然',options);
  assert.ok([b.id,c.id].every(id=>wrong.some(h=>h.document_id===id)),'A wrong hint cannot remove correct ordinary evidence');
  assert.ok(wrong.every(h=>h.classification_route_guard?.outsideMatch));
  assert.ok(!wrong.some(h=>h.document_id===a.id),'A superseded logical source and its old labels must not return');
  const wrongHint=wrong.find(h=>h.document_id===changed.id);assert.ok(wrongHint);assert.equal(wrongHint.body,'Atoms only.');
  assert.equal(wrongHint.retrieval_mode,'classification-witness');assert.equal(wrongHint.lexical_support,0);
  assert.equal(wrongHint.classification_route_guard?.classificationRecall?.semanticVerified,false,'Wrong hints may offer original text but never certify it');
  await kernel.recordContentTaxonomy(owner,{previousId:taxonomy.id,entries:[]},'fixture-admin','Withdraw aliases');
  assert.deepEqual(await kernel.searchDocumentText(owner,'最大似然',options),[]);
  assert.deepEqual((await kernel.searchDocumentText(owner,'likelihood',options)).map(h=>h.document_id).sort(),[b.id,c.id].sort());
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=saved;}
});
