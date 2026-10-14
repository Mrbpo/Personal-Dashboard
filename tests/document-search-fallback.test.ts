import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const directory=mkdtempSync(join(tmpdir(),'document-search-fallback-'));
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=directory;
process.env.OPENAI_API_KEY='dummy-never-sent';
process.env.AI_BUDGET_TEST_BYPASS='false';
process.env.AI_MONTHLY_BUDGET='5';
after(()=>rmSync(directory,{recursive:true,force:true}));

test('AI page ordering still runs after semantic failure and retains scoped current evidence',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernel}=await import('../lib/kernel/service.ts');
 const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
 await migrateKernel();
 const owner=`fallback-${randomUUID()}`,documentId=`document-${randomUUID()}`;
 const document={id:documentId,ownerId:owner,courseId:'',name:'Kinetic energy.pdf',
  hash:randomUUID(),mime:'application/pdf',origin:'upload',originKey:documentId};
 const pages=[
  {pageNumber:1,locator:'第 1 页',text:'Kinetic energy is listed here. Kinetic energy is a chapter heading; this index does not explain the calculation.'},
  {pageNumber:2,locator:'第 2 页',text:'Kinetic energy is calculated as K = one half of mass multiplied by squared speed. Changes subtract initial from final energy.'},
 ];
 const factCounts=async()=>((await kernelPool().query<{facts:string;candidates:string}>(
  'SELECT (SELECT count(*) FROM facts) facts,(SELECT count(*) FROM candidate_facts) candidates')).rows[0]);
 const before=await factCounts();
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'fallback-test',expectedPages:2});
 const keyword=await kernel.searchDocumentText(owner,'kinetic energy',{limit:2});
 assert.equal(keyword.length,2);
 assert.deepEqual(await kernel.searchDocumentText('other-'+owner,'kinetic energy',{limit:2}),[]);
 const current=(await kernelPool().query<{page_number:number;body:string;evidence_id:string;source_version_id:string}>(
  `SELECT p.page_number,p.body,p.evidence_id,v.source_version_id FROM document_texts d
   JOIN document_text_versions v ON v.id=d.current_version_id
   JOIN document_text_pages p ON p.version_id=v.id WHERE d.owner_id=$1 AND d.id=$2`,[owner,documentId])).rows;
 const priorFetch=globalThis.fetch;
 let embeddingCalls=0,rerankCalls=0;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://api.openai.com/v1/embeddings'){
   embeddingCalls++;
   throw new Error('embedding-unavailable-for-test');
  }
  assert.equal(url,'https://api.openai.com/v1/responses','all network access must be mocked');
  rerankCalls++;
  const request=JSON.parse(String(init?.body));
  assert.equal(request.model,'gpt-5-mini');
  const candidates=JSON.parse(request.input[1].content).pages as {id:string;text:string}[];
  assert.deepEqual(candidates.map(page=>page.id),['p0','p1']);
  assert.equal(candidates.length,2);
  assert.deepEqual(new Set(candidates.map(page=>page.text)),new Set(pages.map(page=>page.text)));
  return Response.json({status:'completed',output_text:JSON.stringify({orderedIds:['p1','p0']}),
   usage:{input_tokens:100,output_tokens:20}});
 };
 try{
  const result=await kernel.searchDocumentText(owner,'kinetic energy',{limit:2,aiRerank:true});
  assert.deepEqual(result.map(hit=>hit.id),keyword.map(hit=>hit.id).reverse());
  assert.equal(embeddingCalls,1);
  assert.equal(rerankCalls,1);
  for(const hit of result){
   const original=keyword.find(row=>row.id===hit.id)!;
   const page=current.find(row=>row.page_number===hit.page_number)!;
   assert.equal(hit.document_id,documentId);
   assert.equal(hit.body,original.body);
   assert.equal(hit.locator,original.locator);
   assert.equal(hit.evidence_id,page.evidence_id);
   assert.equal(hit.source_version_id,page.source_version_id);
   assert.equal(hit.retrieval_mode,'ai-rerank');
   assert.match(hit.degraded_reason||'',/semantic/i);
  }
  assert.deepEqual(await factCounts(),before,'document ordering must not create canonical or candidate facts');
 }finally{globalThis.fetch=priorFetch;}
});

for(const failure of ['semantic','ai-rerank'] as const){
 test(`PDF reparse during ${failure} request refreshes scoped keyword fallback evidence`,
  {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
  const {kernel}=await import('../lib/kernel/service.ts');
  const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
  await migrateKernel();
  const tag=randomUUID(),owner=`reparse-${tag}`,documentId=`reparse-document-${tag}`,
   courseId=`reparse-course-${tag}`,otherCourseId=`other-course-${tag}`;
  await kernel.upsertCourse({id:courseId,name:'Reparse regression',course_code:`REPARSE-${tag}`});
  await kernel.upsertCourse({id:otherCourseId,name:'Other course',course_code:`OTHER-${tag}`});
  const document={id:documentId,ownerId:owner,courseId,name:'Energy.pdf',hash:randomUUID(),
   mime:'application/pdf',origin:'upload',originKey:documentId};
  const query='kinetic energy',oldBody='Kinetic energy uses the superseded transcription on this page.';
  await kernel.ingestParsedDocument(document,[{pageNumber:1,locator:'第 1 页',text:oldBody}],
   {parserVersion:'reparse-before',expectedPages:1});
  const before=(await kernel.searchDocumentText(owner,query,{courseId,documentId,limit:2}))[0];
  assert.ok(before);
  // Other owners, courses and document IDs must not enter the fallback query.
  for(const [suffix,fixtureOwner,fixtureCourse] of [
   ['other-owner','other-'+owner,courseId],['other-course',owner,otherCourseId],['other-document',owner,courseId],
  ])await kernel.ingestParsedDocument({...document,id:`${documentId}-${suffix}`,ownerId:fixtureOwner,
   courseId:fixtureCourse,originKey:`${documentId}-${suffix}`},
   [{pageNumber:1,locator:'第 1 页',text:'Kinetic energy outside the requested document scope.'}],
   {parserVersion:'scope-fixture',expectedPages:1});
  const newBody='Kinetic energy now has the corrected transcription on the second source page.';
  const reparse=()=>kernel.ingestParsedDocument(document,[
   {pageNumber:1,locator:'第 1 页',text:'Preface without the requested concept.'},
   {pageNumber:2,locator:'第 2 页',text:newBody},
  ],{parserVersion:'reparse-after',expectedPages:2});
  const originalFetch=globalThis.fetch;
  let embeddingCalls=0,rerankCalls=0,reparsed=false;
  globalThis.fetch=async(input,init)=>{
   const url=String(input);
   if(url==='https://api.openai.com/v1/embeddings'){
    embeddingCalls++;
    if(failure==='semantic'){await reparse();reparsed=true;}
    throw new Error('embedding-unavailable-for-test');
   }
   assert.equal(url,'https://api.openai.com/v1/responses','all model requests must be mocked');
   assert.equal(failure,'ai-rerank');
   rerankCalls++;
   const request=JSON.parse(String(init?.body));
   const candidates=JSON.parse(request.input[1].content).pages as {id:string;text:string}[];
   assert.equal(candidates.length,1);
   assert.equal(candidates[0].text,oldBody,'the reparse must occur after old candidates reach the model');
   await reparse();reparsed=true;
   return Response.json({status:'completed',output_text:JSON.stringify({orderedIds:[candidates[0].id]}),
    usage:{input_tokens:100,output_tokens:20}});
  };
  try{
   const result=await kernel.searchDocumentText(owner,query,{courseId,documentId,limit:2,strict:false,
    semantic:true,aiRerank:failure==='ai-rerank'});
   assert.equal(reparsed,true);
   assert.equal(embeddingCalls,1,'fallback must not retry embeddings');
   assert.equal(rerankCalls,failure==='ai-rerank'?1:0,'fallback must not retry AI ordering');
   const current=(await kernelPool().query<{body:string;evidence_id:string;source_version_id:string}>(
    `SELECT p.body,p.evidence_id,v.source_version_id FROM document_texts d
     JOIN document_text_versions v ON v.id=d.current_version_id
     JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=2
     WHERE d.owner_id=$1 AND d.id=$2`,[owner,documentId])).rows[0];
   assert.notEqual(current.source_version_id,before.source_version_id,'reparse creates a new source version for the same PDF bytes');
   assert.notEqual(current.evidence_id,before.evidence_id);
   assert.equal(result.length,1);
   const hit=result[0];
   assert.equal(hit.document_id,documentId);
   assert.equal(hit.course_id,courseId);
   assert.equal(hit.source_hash,document.hash,'the original PDF is unchanged');
   assert.equal(hit.page_number,2);
   assert.equal(hit.body,current.body);
   assert.equal(hit.body,newBody);
   assert.equal(hit.evidence_id,current.evidence_id);
   assert.equal(hit.source_version_id,current.source_version_id);
   assert.equal(hit.parser_version,'reparse-after');
   assert.equal(hit.retrieval_mode,'keyword-fallback');
   assert.equal(hit.degraded_reason,failure==='ai-rerank'?'semantic:unavailable;ai:stale-version':'semantic:unavailable');
   assert.ok(result.every(row=>row.body!==oldBody&&row.evidence_id!==before.evidence_id));
  }finally{globalThis.fetch=originalFetch;}
 });
}
