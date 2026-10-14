import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {queueDocumentVectorJobs,runDocumentVectorJob} from '../lib/kernel/document-vector.ts';
import {claimIngestionJob,finishIngestionJob} from '../lib/kernel/jobs.ts';

after(async()=>{await kernelPool().end();});

test('unchanged PDF body keeps immutable quality history, idempotent replay and zero-fee vector reuse',async()=>{
 await migrateKernel();
 const pool=kernelPool(),tag=randomUUID(),owner=`quality-version-${tag}`,id=`quality-document-${tag}`;
 const document={id,ownerId:owner,courseId:'',name:'Quality fixture.pdf',hash:tag,mime:'application/pdf',origin:'upload',originKey:id};
 const pages=[{pageNumber:1,locator:'Page 1',text:'A stable independent explanation with an extracted machine formula.'}];
 const options={parserVersion:'quality-test-v1',extractionMethod:'docling-body',expectedPages:1};
 const head=async()=>(await pool.query(`SELECT v.id,v.source_version_id,v.text_hash,v.warnings,p.evidence_id
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
  JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=1 WHERE d.owner_id=$1 AND d.id=$2`,[owner,id])).rows[0];
 const index=async(embed:(inputs:string[],deadline:number)=>Promise<number[][]>)=>{
  const [jobId]=await queueDocumentVectorJobs(pool,owner,{documentId:id});
  const job=(await claimIngestionJob(jobId))!;
  const result=await runDocumentVectorJob(pool,job,{embed});
  await finishIngestionJob(job.id,job.lease_token);return result;
 };
 await kernel.ingestParsedDocument(document,pages,options);
 const old=await head();
 await index(async inputs=>inputs.map(()=>Array.from({length:768},(_,i)=>i===0?1:0)));
 await kernel.ingestParsedDocument(document,pages,{...options,warnings:[' Unverified symbols ','Unverified subscripts','Unverified symbols']});
 const current=await head();
 assert.notEqual(current.id,old.id);assert.notEqual(current.source_version_id,old.source_version_id);
 assert.notEqual(current.evidence_id,old.evidence_id);assert.equal(current.text_hash,old.text_hash);
 assert.deepEqual(current.warnings,['Unverified subscripts','Unverified symbols']);
 assert.deepEqual((await pool.query('SELECT warnings FROM document_text_versions WHERE id=$1',[old.id])).rows[0].warnings,[]);
 assert.equal((await pool.query('SELECT original_excerpt FROM evidence WHERE id=$1',[old.evidence_id])).rows[0].original_excerpt,pages[0].text);
 await kernel.ingestParsedDocument(document,pages,{...options,warnings:['Unverified symbols','Unverified subscripts'],
  batchProvenance:{remoteTaskId:randomUUID(),acquiredAt:new Date().toISOString()}});
 assert.equal((await head()).id,current.id,'warning order/duplicates and transient task metadata do not create versions');
 assert.equal(Number((await pool.query('SELECT count(*) n FROM source_item_versions WHERE source_item_id=$1',[`document:${id}`])).rows[0].n),2);
 const reused=await index(async()=>{throw new Error('Quality-only change must reuse exact full-page embedding; no remote call');});
 assert.equal(reused.indexedPages,1);assert.equal(reused.reusedPages,1);
 assert.equal((await kernel.searchDocumentText(owner,'stable independent'))[0].evidence_id,current.evidence_id);
 assert.deepEqual((await kernel.parsedDocument(owner,id))[0].warnings,current.warnings);
 await kernel.ingestParsedDocument(document,pages,{...options,warnings:current.warnings,extractionMethod:'docling-reviewed-body'});
 const changedMethod=await head();
 assert.notEqual(changedMethod.id,current.id);assert.notEqual(changedMethod.source_version_id,current.source_version_id);
 assert.equal((await kernel.parsedDocument(owner,id))[0].extraction_method,'docling-reviewed-body');
 await kernel.ingestParsedDocument(document,pages,{...options,warnings:current.warnings,extractionMethod:'docling-reviewed-body'});
 assert.equal((await head()).id,changedMethod.id);
 assert.equal(Number((await pool.query('SELECT count(*) n FROM document_text_versions WHERE document_id=$1',[id])).rows[0].n),3);
});
