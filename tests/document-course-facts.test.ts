import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {extractDocumentCourseFactCandidates,documentCourseFactsEnabled,queueDocumentCourseFactJob,
 DOCUMENT_COURSE_FACT_JOB_KIND,DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION} from '../lib/kernel/document-course-facts.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {claimIngestionJob,finishIngestionJob} from '../lib/kernel/jobs.ts';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
const page=(body:string,pageNumber=1)=>({pageNumber,evidenceId:sha('page:'+pageNumber),locator:'page '+pageNumber,body});

test('explicit PDF line proposals preserve exact original spans, date precision and parser identity',()=>{
 const source=page('Course overview\r\n  Assignment 2: Graphs  \r\n  Due: 2026-11-03 at 10:30 EST\r\nSubmit one PDF using Canvas.\r\nGrading: 20% correctness.\r\nFinal exam: 2026-12-09\r\nLate submissions lose 5%.');
 const rows=extractDocumentCourseFactCandidates([source]);assert.equal(rows.length,6);
 for(const row of rows){
  assert.equal(row.originalExcerpt,source.body.slice(row.startUtf16,row.endUtf16));
  assert.equal(row.value.text,row.originalExcerpt);assert.equal(row.pageBodySha256,sha(source.body));
  assert.equal(row.extractorVersion,DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION);
  assert.equal(row.value.time,null);assert.equal(row.value.timezone,null);
  assert.ok(row.locator.startsWith('page 1; course-fact utf16 '));
 }
 const due=rows.find(row=>row.value.kind==='due')!;assert.equal(due.value.date,'2026-11-03');assert.equal(due.attribute,'course_requirement');
 assert.equal(due.value.title,'Assignment 2: Graphs');assert.equal(rows.find(row=>row.attribute==='exam')?.value.date,'2026-12-09');
 assert.deepEqual(extractDocumentCourseFactCandidates([source]),rows);
});

test('ambiguous and invalid dates stay unknown; headings never carry across physical pages',()=>{
 const rows=extractDocumentCourseFactCandidates([page('Assignment 1: Analysis\nDue: November 3\nDue: 2026-02-30\nDue: 2026-11-03 or 2026-11-04\nDue: 11/03'),
  page('Due: 2026-12-01',2)]);
 assert.equal(rows.length,6);assert.ok(rows.slice(1,5).every(row=>row.value.date===null));
 assert.equal(rows.at(-1)?.value.title,null);assert.equal(rows.at(-1)?.value.date,'2026-12-01');
 assert.ok(rows.every(row=>!('at' in row.value)&&row.value.timezone===null));
});

test('literal extraction ignores ordinary prose, tables, examples and duplicate lines',()=>{
 assert.deepEqual(extractDocumentCourseFactCandidates([page('The theorem proves convergence.\nAn example exam question follows.\nExample: Due: 2026-11-03\n| Due: 2026-11-03 |')]),[]);
 const rows=extractDocumentCourseFactCandidates([page('Submit one PDF.\nSubmit one PDF.'),page('Submit one PDF.',2)]);
 assert.equal(rows.length,1);assert.equal(rows[0].pageNumber,1);
});

test('candidate extraction is bounded without truncating verbatim excerpts',()=>{
 const rows=extractDocumentCourseFactCandidates([page('Submit '+'.'.repeat(1200)+'\n'+Array.from({length:205},(_,i)=>`Assignment ${i}: Topic`).join('\n'))]);
 assert.equal(rows.length,200);assert.equal(rows[0].originalExcerpt,'Assignment 0: Topic');
});

test('queue defaults off and never reads the database without explicit opt in',async()=>{
 const saved=process.env.KERNEL_DOCUMENT_FACTS;let calls=0;
 const client={query:async()=>{calls++;throw Error('unexpected database call');}} as unknown as Parameters<typeof queueDocumentCourseFactJob>[0];
 try{
  delete process.env.KERNEL_DOCUMENT_FACTS;assert.equal(documentCourseFactsEnabled(),false);
  assert.deepEqual(await queueDocumentCourseFactJob(client,'owner','document','version'),{queued:false});
  process.env.KERNEL_DOCUMENT_FACTS='1';assert.equal(documentCourseFactsEnabled(),false);assert.equal(calls,0);
 }finally{if(saved===undefined)delete process.env.KERNEL_DOCUMENT_FACTS;else process.env.KERNEL_DOCUMENT_FACTS=saved;}
});

test('incremental PDF jobs persist only pending candidates with owned current-page provenance and replay safely',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernel}=await import('../lib/kernel/service.ts');await migrateKernel();
 const uid=randomUUID(),owner='document-facts:'+uid,saved=process.env.KERNEL_DOCUMENT_FACTS,fetchSaved=globalThis.fetch;
 const add=async(name:string,mime='application/pdf',parser='fixture-pdf-facts-v1')=>{
  const body='Assignment 1: Trees\nDue: 2026-11-03\nLate submissions lose 5%.',doc={id:sha(uid+name),ownerId:owner,courseId:'',name:name+'.pdf',hash:sha(body),mime,origin:'fixture-document-facts',originKey:uid+name};
  await kernel.ingestParsedDocument(doc,[{pageNumber:1,locator:'page 1',text:body}],{parserVersion:parser,extractionMethod:'fixture',
   ...(mime==='application/pdf'?{pageStructure:'physical-pages-v1' as const}:{})});return doc;
 };
 const jobs=async(id:string)=>(await kernelPool().query('SELECT * FROM ingestion_jobs WHERE kind=$1 AND scope=$2 ORDER BY id',[DOCUMENT_COURSE_FACT_JOB_KIND,id])).rows;
 try{
  globalThis.fetch=async()=>{throw Error('Document rule extraction must not call a provider');};
  delete process.env.KERNEL_DOCUMENT_FACTS;const off=await add('off');assert.equal((await jobs(off.id)).length,0);
  process.env.KERNEL_DOCUMENT_FACTS='true';const text=await add('text','text/plain');assert.equal((await jobs(text.id)).length,0);
  const doc=await add('on');assert.equal((await jobs(doc.id)).length,1);await add('on');assert.equal((await jobs(doc.id)).length,1);
  const anchors=await kernel.searchDocumentText(owner,'Assignment',{documentId:doc.id,limit:1,semantic:false,hybrid:false,aiRerank:false,evidenceBody:'full-page'});
  assert.equal(anchors.length,1);
  assert.ok(await kernel.readDocumentParents(owner,anchors,{includeImages:false}),'native PDF ingestion must publish page-only context without inventing section relationships');
  const job=await claimIngestionJob((await jobs(doc.id))[0].id);assert.ok(job);
  await kernel.runDocumentCourseFactJob(job);await kernel.runDocumentCourseFactJob(job);
  const candidates=(await kernelPool().query(`SELECT c.*,m.*,e.original_excerpt FROM document_course_fact_candidates m
   JOIN candidate_facts c ON c.id=m.candidate_id JOIN evidence e ON e.id=c.evidence_id WHERE m.owner_id=$1`,[owner])).rows;
  assert.equal(candidates.length,3);assert.ok(candidates.every(c=>c.status==='pending'&&c.document_id===doc.id));
  assert.equal((await kernelPool().query('SELECT f.id FROM facts f JOIN candidate_facts c ON c.id=f.chosen_candidate_id JOIN document_course_fact_candidates m ON m.candidate_id=c.id WHERE m.owner_id=$1',[owner])).rowCount,0);
  await finishIngestionJob(job.id,job.lease_token);await assert.rejects(kernel.runDocumentCourseFactJob(job),/lease lost/);
  const stale=await add('stale'),old=(await jobs(stale.id))[0];await add('stale','application/pdf','fixture-pdf-facts-v2');
  const staleJob=await claimIngestionJob(old.id);assert.ok(staleJob);await assert.rejects(kernel.runDocumentCourseFactJob(staleJob),/source version changed/);
  await finishIngestionJob(staleJob.id,staleJob.lease_token,'Fixture stale source');
  const hidden=await add('hidden'),hiddenJob=await claimIngestionJob((await jobs(hidden.id))[0].id);assert.ok(hiddenJob);
  await kernelPool().query('UPDATE document_texts SET hidden=true WHERE id=$1',[hidden.id]);
  await assert.rejects(kernel.runDocumentCourseFactJob(hiddenJob),/source version changed/);
  await finishIngestionJob(hiddenJob.id,hiddenJob.lease_token,'Fixture hidden source');
 }finally{globalThis.fetch=fetchSaved;if(saved===undefined)delete process.env.KERNEL_DOCUMENT_FACTS;else process.env.KERNEL_DOCUMENT_FACTS=saved;}
});
