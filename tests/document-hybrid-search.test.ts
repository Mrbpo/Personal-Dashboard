import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const directory=mkdtempSync(join(tmpdir(),'study-tests-hybrid-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=directory+'/library';
process.env.SERVICE_VAULT_DIR=directory+'/vault';
process.env.KERNEL_DOCUMENT_HYBRID='false';
process.env.KERNEL_DOCUMENT_RERANK='false';
after(()=>rmSync(directory,{recursive:true,force:true}));

test('independent dense recall finds a page with no query words and respects top-k through both entry points',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernel}=await import('../lib/kernel/service.ts');
 const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
 const library=await import('../lib/library.ts');
 const {database}=await import('../lib/database.ts');
 const {claimIngestionJob,finishIngestionJob}=await import('../lib/kernel/jobs.ts');
 const {runDocumentVectorJob}=await import('../lib/kernel/document-vector.ts');
 const {DOCUMENT_EMBEDDING_MODEL}=await import('../lib/kernel/document-semantic.ts');
 await migrateKernel();
 const owner='hybrid-'+randomUUID();
 const id=await library.saveDocument(owner,'','upload','pets','Pets.pdf','application/pdf',Buffer.from('%PDF-1.4 synthetic fixture'));
 const document=await library.getDocument(owner,id);
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:document.name,hash:document.hash,
  mime:document.mime,origin:document.origin,originKey:document.origin_key},
  [{pageNumber:1,locator:'第 1 页',text:'Domestic cats are small mammals often kept as household pets.'},
   {pageNumber:2,locator:'第 2 页',text:'Rock formations are layered structures studied by geologists.'}],
  {parserVersion:'hybrid-test',expectedPages:2});
 await database.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
 const one=(position:number)=>Array.from({length:768},(_,index)=>Number(index===position));
 const [jobId]=await kernel.queueDocumentVectorJobs(owner);
 const job=await claimIngestionJob(jobId);
 assert.ok(job);
 await runDocumentVectorJob(kernelPool(),job,{embed:async inputs=>inputs.map(input=>one(input.startsWith('Domestic')?0:1))});
 await finishIngestionJob(job.id,job.lease_token);
 const query='feline companions';
 await kernelPool().query(`INSERT INTO document_query_embeddings(owner_id,query_hash,model,embedding)
  VALUES ($1,$2,$3,$4::double precision[])`,[owner,createHash('sha256').update(query).digest('hex'),DOCUMENT_EMBEDDING_MODEL,one(0)]);
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('Fully prepared query must not send network requests');};
 try{
  assert.deepEqual(await kernel.searchDocumentText(owner,query,{limit:1}),[],'no lexical candidate exists');
  const core=await kernel.searchDocumentText(owner,query,{limit:1,hybrid:true});
  const compatible=await library.searchLibrary(owner,query,'',false,{limit:1,hybrid:true});
  assert.equal(core.length,1,'top-1 must not silently contain the whole candidate set');
  assert.equal(compatible.length,1);
  assert.equal(core[0].document_id,id);assert.equal(core[0].page_number,1);
  assert.equal(compatible[0].evidence_id,core[0].evidence_id);
  assert.deepEqual(await kernel.searchDocumentText('other-'+owner,query,{limit:1,hybrid:true}),[]);
  assert.deepEqual(await kernel.searchDocumentText(owner,query,{courseId:'unknown',limit:1,hybrid:true}),[]);
  await database.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(
    id+':legacy',id,0,'第 1 页','Domestic cats are household pets.','legacy-hash').run();
  process.env.KERNEL_DOCUMENT_HYBRID='true';
  try{assert.equal(await library.embedMissing(owner),0,'kernel pages must not be embedded again into the legacy cache');}
  finally{process.env.KERNEL_DOCUMENT_HYBRID='false';}
 }finally{globalThis.fetch=original;}
});

test('an incomplete dense index returns current keyword evidence without embedding the corpus on a query',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernel}=await import('../lib/kernel/service.ts');
 const {migrateKernel}=await import('../lib/kernel/db.ts');
 await migrateKernel();
 const owner='partial-hybrid-'+randomUUID(),id=randomUUID();
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Ocean.pdf',hash:randomUUID(),
  mime:'application/pdf',origin:'upload',originKey:id},
  [{pageNumber:1,locator:'第 1 页',text:'Ocean tides are driven by gravitational forces.'}],
  {parserVersion:'hybrid-partial-test',expectedPages:1});
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Query must not backfill missing page embeddings');};
 try{
  const result=await kernel.searchDocumentText(owner,'ocean tides',{limit:1,hybrid:true});
  assert.equal(calls,0);assert.equal(result.length,1);
  assert.equal(result[0].document_id,id);
  assert.equal(result[0].retrieval_mode,'keyword-fallback');
  assert.equal(result[0].degraded_reason,'semantic:index-incomplete');
 }finally{globalThis.fetch=original;}
});

test('actual hybrid retrieval retains independent lexical and dense evidence when many shared pages would crowd both out',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const{kernel}=await import('../lib/kernel/service.ts'),{kernelPool,migrateKernel}=await import('../lib/kernel/db.ts'),
  {claimIngestionJob,finishIngestionJob}=await import('../lib/kernel/jobs.ts'),
  {runDocumentVectorJob,searchDocumentVectorText,fuseIndependentDocumentRanks}=await import('../lib/kernel/document-vector.ts'),
  {DOCUMENT_EMBEDDING_MODEL}=await import('../lib/kernel/document-semantic.ts');
 await migrateKernel();const uid=randomUUID(),owner='head-retention:'+uid,lexicalId='z-lexical:'+uid,denseId='a-dense:'+uid,
  sharedId='m-shared:'+uid,query='mercury orbital calibration',axis=(n:number)=>Array.from({length:768},(_,i)=>Number(i===n));
 const ingest=async(id:string,texts:string[])=>kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:id+'.txt',hash:createHash('sha256').update(texts.join('\n')).digest('hex'),
  mime:'text/plain',origin:'upload',originKey:id},texts.map((text,i)=>({pageNumber:i+1,locator:'page '+(i+1),text})),{parserVersion:'hybrid-head-fixture',expectedPages:texts.length});
 await ingest(lexicalId,['Focused mercury orbital calibration requires measuring residuals before fitting.']);
 await ingest(denseId,['A geometric residual explanation using an alternative vocabulary.']);
 await ingest(sharedId,Array.from({length:50},(_,i)=>'Mercury orbital background. '+('A lengthy collection of general supporting examples. '.repeat(30))+i));
 for(const jobId of await kernel.queueDocumentVectorJobs(owner)){const job=(await claimIngestionJob(jobId))!;
  await runDocumentVectorJob(kernelPool(),job,{embed:async values=>values.map(v=>axis(v.startsWith('Focused')?1:0))});await finishIngestionJob(job.id,job.lease_token);}
 await kernelPool().query('INSERT INTO document_query_embeddings(owner_id,query_hash,model,embedding) VALUES($1,$2,$3,$4::double precision[])',
  [owner,createHash('sha256').update(query).digest('hex'),DOCUMENT_EMBEDDING_MODEL,axis(0)]);
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Head-retention integration uses cached fixtures only');};
 try{
  const opts={relatedDocuments:false,refineAdjacent:false,aiRerank:false},lexical=await kernel.searchDocumentText(owner,query,{...opts,limit:80,semantic:false,hybrid:false}),
   dense=await searchDocumentVectorText(kernelPool(),owner,axis(0),{limit:80});
  assert.equal(lexical[0].document_id,lexicalId);assert.equal(dense.hits[0].document_id,denseId);
  const old=fuseIndependentDocumentRanks(lexical,dense.hits,6);assert.ok(!old.some(h=>h.document_id===lexicalId));assert.ok(!old.some(h=>h.document_id===denseId));
  const result=await kernel.searchDocumentText(owner,query,{...opts,limit:6,semantic:true,hybrid:true});
  assert.equal(result.length,6);assert.ok(result.some(h=>h.document_id===lexicalId));assert.ok(result.some(h=>h.document_id===denseId));
  assert.equal(new Set(result.map(h=>h.evidence_id)).size,6);assert.equal(calls,0);
  assert.deepEqual(await kernel.searchDocumentText('foreign:'+owner,query,{...opts,limit:6,hybrid:true}),[]);
 }finally{globalThis.fetch=original;}
});
