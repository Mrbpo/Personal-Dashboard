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
