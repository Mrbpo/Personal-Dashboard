import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{documentEmbeddingInput,documentEmbeddingInputPolicy,documentEmbeddingTokenCount,assertDocumentEmbeddingInput}from'../lib/kernel/document-embedding-input.ts';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{claimIngestionJob,finishIngestionJob}from'../lib/kernel/jobs.ts';
import{queueDocumentVectorJobs,runDocumentVectorJob,documentVectorCoverage,searchDocumentVectorText}from'../lib/kernel/document-vector.ts';
import{DOCUMENT_EMBEDDING_DIMENSIONS,embedDocumentInputs}from'../lib/kernel/document-semantic.ts';
let providers=0;globalThis.fetch=async()=>{providers++;throw Error('Full-page input controls forbid external calls');};
after(async()=>{try{assert.equal(providers,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});

test('full-page policy preserves a >6000-character tail with a distinct hash; legacy bytes stay unchanged',()=>{
 const text='intro '.repeat(1100)+'unique appendix explanation',legacy=documentEmbeddingInput(text,'page-prefix-v1'),full=documentEmbeddingInput(text,'page-full-v1');
 assert.equal(legacy.input,Array.from(text).slice(0,6000).join('').trim());assert.ok(!legacy.input.includes('appendix'));
 assert.equal(full.input,text);assert.notEqual(full.inputHash,legacy.inputHash);
 assert.deepEqual(documentEmbeddingInput(' short text ','page-full-v1'),documentEmbeddingInput(' short text ','page-prefix-v1'));
 assert.equal(documentEmbeddingInputPolicy('page-full-v1'),'page-full-v1');assert.throws(()=>documentEmbeddingInputPolicy('guess'),/policy/);
 assert.equal(documentEmbeddingTokenCount('antidisestablishmentarianism'),6,'Official cl100k example');
 assert.ok(documentEmbeddingTokenCount('<|endoftext|>')>1,'Special-looking source text is literal');
 assert.throws(()=>documentEmbeddingInput('bad\ud800','page-full-v1'),/surrogate/);
});

test('token overflow fails before network or key lookup; full text is not silently shortened',async()=>{
 const boundary=' a'.repeat(8192),overflow=boundary+' a';assert.equal(documentEmbeddingTokenCount(boundary),8192);
 assertDocumentEmbeddingInput(boundary);assert.throws(()=>documentEmbeddingInput(overflow,'page-full-v1'),/8192/);
 await assert.rejects(embedDocumentInputs([overflow],Date.now()+10000),/8192/);assert.equal(providers,0);
});

test('durable full-page jobs keep captured policy across restart, preserve old cache and reject oversized pages before embedding',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),id=randomUUID(),owner='full-page:'+id,documentId='full-document:'+id,
  saved=process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT,body='intro '.repeat(1100)+'unique appendix explanation',
  vector=Array.from({length:DOCUMENT_EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0),
  doc={id:documentId,ownerId:owner,courseId:'',name:'Long page.pdf',hash:'source-'+id,mime:'application/pdf',origin:'upload',originKey:id};
 const inputPage=(text:string)=>[{pageNumber:1,locator:'page 1',text}],inputs:string[]=[];
 const run=async(job:NonNullable<Awaited<ReturnType<typeof claimIngestionJob>>>)=>{
  const result=await runDocumentVectorJob(pool,job,{embed:async values=>{inputs.push(...values);return values.map(()=>vector);}});
  await finishIngestionJob(job.id,job.lease_token);return result;
 };
 try{
  process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT='page-prefix-v1';await kernel.ingestParsedDocument(doc,inputPage(body),{parserVersion:'full-input-before'});
  const[legacyId]=await queueDocumentVectorJobs(pool,owner),legacy=(await claimIngestionJob(legacyId))!;await run(legacy);
  assert.equal(inputs[0],documentEmbeddingInput(body,'page-prefix-v1').input);
  process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT='page-full-v1';assert.equal((await documentVectorCoverage(pool,owner)).complete,false);
  const[fullId]=await queueDocumentVectorJobs(pool,owner);assert.notEqual(fullId,legacyId);
  const full=(await claimIngestionJob(fullId))!;assert.equal((full.payload as {inputPolicy:string}).inputPolicy,'page-full-v1');
  process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT='page-prefix-v1';await run(full);assert.equal(inputs[1],body,'Restart environment cannot downgrade the captured job input');
  process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT='page-full-v1';
  assert.deepEqual(await documentVectorCoverage(pool,owner),{totalPages:1,searchablePages:1,indexedPages:1,emptyPages:0,complete:true,inputPolicy:'page-full-v1'});
  assert.deepEqual(await queueDocumentVectorJobs(pool,owner),[]);assert.equal(Number((await pool.query('SELECT count(*) n FROM document_page_embeddings WHERE owner_id=$1',[owner])).rows[0].n),2);
  const found=await searchDocumentVectorText(pool,owner,vector);assert.equal(found.hits[0].body,body);assert.equal(found.hits[0].document_id,documentId);
  assert.equal((await searchDocumentVectorText(pool,'foreign:'+owner,vector)).hits.length,0);
  assert.equal((await searchDocumentVectorText(pool,owner,vector,{documentId:'foreign'})).hits.length,0);
  await kernel.ingestParsedDocument(doc,inputPage(body+' changed tail'),{parserVersion:'full-input-after'});
  assert.equal((await documentVectorCoverage(pool,owner)).indexedPages,0);assert.equal((await searchDocumentVectorText(pool,owner,vector)).hits.length,0);
  const[changedId]=await queueDocumentVectorJobs(pool,owner),changed=(await claimIngestionJob(changedId))!;await run(changed);assert.equal(inputs.at(-1),body+' changed tail');
  await kernel.ingestParsedDocument(doc,inputPage(' a'.repeat(8193)),{parserVersion:'full-input-overflow'});
  const[overflowId]=await queueDocumentVectorJobs(pool,owner),oversized=(await claimIngestionJob(overflowId))!,count=inputs.length;
  await assert.rejects(run(oversized),/8192/);assert.equal(inputs.length,count);assert.equal((await documentVectorCoverage(pool,owner)).complete,false);
  await finishIngestionJob(oversized.id,oversized.lease_token,'Input overflow; no model call');
 }finally{if(saved===undefined)delete process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT;else process.env.KERNEL_DOCUMENT_EMBEDDING_INPUT=saved;}
});
