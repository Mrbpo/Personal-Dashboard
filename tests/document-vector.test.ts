import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {claimIngestionJob,finishIngestionJob} from '../lib/kernel/jobs.ts';
import {DOCUMENT_EMBEDDING_DIMENSIONS} from '../lib/kernel/document-semantic.ts';
import {documentVectorInput,documentVectorCoverage,queueDocumentVectorJobs,runDocumentVectorJob,
  searchDocumentVectorText,fuseIndependentDocumentRanks} from '../lib/kernel/document-vector.ts';
import type {DocumentTextHit} from '../lib/kernel/document-search.ts';

const vector=(axis=0)=>Array.from({length:DOCUMENT_EMBEDDING_DIMENSIONS},(_,index)=>index===axis?1:0);
const document=(owner:string,id:string,courseId='',originKey=id)=>({id,ownerId:owner,courseId,
  name:'Learning.pdf',hash:id,mime:'application/pdf',origin:'upload',originKey,createdAt:'2026-01-01T12:00:00Z'});
const page=(text:string,pageNumber=1)=>({pageNumber,locator:`第 ${pageNumber} 页`,text});
const hit=(id:string,version='source'):DocumentTextHit=>({id,document_id:id,page_number:1,course_id:'',
  name:id,origin:'upload',origin_key:id,source_hash:id,body:id,locator:'第 1 页',evidence_id:'evidence-'+version,
  source_version_id:version,parser_version:'test',score:1});

test('independent rank fusion admits dense-only pages and refuses mismatched evidence versions',()=>{
  const lexical=[hit('lexical-only'),hit('shared')],dense=[hit('dense-only'),hit('shared')];
  const results=fuseIndependentDocumentRanks(lexical,dense,3);
  assert.equal(results[0].document_id,'shared');
  assert.deepEqual(new Set(results.map(value=>value.document_id)),new Set(['shared','lexical-only','dense-only']));
  assert.throws(()=>fuseIndependentDocumentRanks([hit('shared')],[hit('shared','new-version')]),/versions conflict/);
  const source='\uFEFF\u00a0'+ '🙂'.repeat(6000)+'truncated';
  assert.equal(Array.from(documentVectorInput(source).input).length,5998,'6000 codepoints precede trim');
});

test('vector jobs atomically resume a partial batch and dense recall preserves owner, scope and current versions',async()=>{
  await migrateKernel();
  const pool=kernelPool(),tag=randomUUID(),owner=`vector-${tag}`,otherOwner=`other-${tag}`;
  const course=`vector-course-${tag}`,id=`vector-document-${tag}`;
  await kernel.upsertCourse({id:course,name:'Learning materials',course_code:'VECTOR101'});
  const doc=document(owner,id,course);
  const pages=Array.from({length:35},(_,index)=>page(index===32?'Synonym target explanation':'Distractor lecture section '+index,index+1));
  // Exercise exactly the same Unicode input/hash expression in PostgreSQL and JS.
  pages[0]=page('\uFEFF\u00a0'+'🙂'.repeat(6000)+'not indexed',1);
  await kernel.ingestParsedDocument(doc,pages,{parserVersion:'vector-test-1',expectedPages:35});
  const [jobId]=await queueDocumentVectorJobs(pool,owner);
  assert.deepEqual(await queueDocumentVectorJobs(pool,owner),[jobId],'duplicate queue shares persistent identity');
  const job=(await claimIngestionJob(jobId))!;
  let calls=0;
  await assert.rejects(runDocumentVectorJob(pool,job,{embed:async inputs=>{
    assert.ok(inputs.length<=32);
    if(++calls===2)throw new Error('controlled second batch interruption');
    return inputs.map(input=>vector(input.includes('Synonym')?0:1));
  }}),/controlled second batch interruption/);
  assert.deepEqual(await documentVectorCoverage(pool,owner),{totalPages:35,searchablePages:35,indexedPages:32,emptyPages:0,complete:false});
  assert.equal((await pool.query('SELECT payload->>\'pageCursor\' cursor FROM ingestion_jobs WHERE id=$1',[jobId])).rows[0].cursor,'32');
  const incomplete=await searchDocumentVectorText(pool,owner,vector());
  assert.equal(incomplete.degradedReason,'incomplete-vector-index');
  assert.equal(incomplete.coverage.complete,false);
  // A worker restart claims an expired lease; cached pages are not re-embedded.
  await pool.query("UPDATE ingestion_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[jobId]);
  const resumed=(await claimIngestionJob(jobId))!;
  const resumeInputs:string[]=[];
  const done=await runDocumentVectorJob(pool,resumed,{embed:async inputs=>{
    resumeInputs.push(...inputs);return inputs.map(input=>vector(input.includes('Synonym')?0:1));
  }});
  assert.equal(done.indexedPages,3);assert.equal(resumeInputs.length,3);assert.equal(done.obsolete,false);
  await finishIngestionJob(resumed.id,resumed.lease_token);
  assert.deepEqual(await queueDocumentVectorJobs(pool,owner),[],'a completed index generates no new paid work');
  const result=await searchDocumentVectorText(pool,owner,vector(),{courseId:course,limit:5});
  assert.equal(result.coverage.complete,true);assert.equal(result.hits[0].page_number,33);
  assert.equal(result.hits[0].body,'Synonym target explanation');
  assert.ok(result.hits[0].evidence_id);assert.ok(result.hits[0].source_version_id);
  assert.equal((await searchDocumentVectorText(pool,otherOwner,vector())).hits.length,0);
  assert.equal((await searchDocumentVectorText(pool,owner,vector(),{courseId:'foreign-course'})).hits.length,0);
  assert.equal((await searchDocumentVectorText(pool,owner,vector(),{documentId:'foreign-document'})).hits.length,0);
  assert.equal((await searchDocumentVectorText(pool,owner,vector(),{documentId:id})).coverage.totalPages,35);

  // A reparse keeps the original cache historically but must not search it.
  await kernel.ingestParsedDocument(doc,[page('New replacement material')],{parserVersion:'vector-test-2',expectedPages:1});
  const replacement=await searchDocumentVectorText(pool,owner,vector());
  assert.equal(replacement.hits.length,0);assert.equal(replacement.coverage.indexedPages,0);
  assert.equal(replacement.coverage.totalPages,1);assert.equal(replacement.degradedReason,'incomplete-vector-index');
  const [newJobId]=await queueDocumentVectorJobs(pool,owner);
  assert.notEqual(newJobId,jobId,'a new parsed version has a distinct durable index job');
  const newJob=(await claimIngestionJob(newJobId))!;
  await runDocumentVectorJob(pool,newJob,{embed:async inputs=>inputs.map(()=>vector())});
  await finishIngestionJob(newJob.id,newJob.lease_token);
  await kernel.hideParsedDocument(owner,id);
  assert.equal((await searchDocumentVectorText(pool,owner,vector())).coverage.totalPages,0);
  assert.equal((await searchDocumentVectorText(pool,owner,vector())).hits.length,0);
});

test('superseded captures and a reparse during a network call never publish searchable stale vectors',async()=>{
  await migrateKernel();
  const pool=kernelPool(),tag=randomUUID(),owner=`vector-capture-${tag}`,originKey=`capture-${tag}`;
  const first=document(owner,`a-${tag}`,'',originKey),latest=document(owner,`z-${tag}`,'',originKey);
  await kernel.ingestParsedDocument(first,[page('First captured lesson')],{parserVersion:'capture-v1'});
  const [oldJobId]=await queueDocumentVectorJobs(pool,owner);
  const oldJob=(await claimIngestionJob(oldJobId))!;
  await kernel.ingestParsedDocument(latest,[page('Latest captured lesson')],{parserVersion:'capture-v1'});
  let calls=0;
  assert.equal((await runDocumentVectorJob(pool,oldJob,{embed:async()=>{calls++;return [vector()];}})).obsolete,true);
  assert.equal(calls,0,'a superseded capture is never embedded');
  const [jobId]=await queueDocumentVectorJobs(pool,owner);
  const job=(await claimIngestionJob(jobId))!;
  const result=await runDocumentVectorJob(pool,job,{embed:async()=>{
    await kernel.ingestParsedDocument(latest,[page('New current parse')],{parserVersion:'capture-v2'});
    return [vector()];
  }});
  assert.equal(result.obsolete,true,'a version replaced during the remote call completes harmlessly');
  assert.equal(Number((await pool.query('SELECT count(*) n FROM document_page_embeddings WHERE owner_id=$1',[owner])).rows[0].n),0);
  assert.equal((await searchDocumentVectorText(pool,owner,vector())).hits.length,0);
  assert.equal((await documentVectorCoverage(pool,owner)).totalPages,1,'equal capture time uses stable identity tie');
});
