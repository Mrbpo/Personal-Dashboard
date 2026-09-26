import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { kernel, parseDeadline } from '../lib/kernel/service.ts';
import { kernelPool, kernelTransaction, migrateKernel } from '../lib/kernel/db.ts';
import { claimIngestionJob, finishIngestionJob, queueIngestionJob } from '../lib/kernel/jobs.ts';

test('deadline precision never fabricates a time',()=>{
  assert.deepEqual(parseDeadline('2026-09-25'),{date:'2026-09-25',at:null,localTime:null,timezone:null,precision:'date',original:'2026-09-25'});
  assert.equal(parseDeadline('2026-09-25T12:30').precision,null);
  assert.equal(parseDeadline('2026-09-25T12:30:00Z').timezone,'Etc/UTC');
});

test('kernel ingestion is idempotent, tracks source absence, resolves newer Canvas evidence and reviews cancellation',async()=>{
  await migrateKernel();
  const courseId=`test:${randomUUID()}`,sourceId=`${courseId}:assignment:42`;
  await kernel.upsertCourse({id:courseId,name:'Math',course_code:'MAT101',updated_at:'2026-09-20T12:00:00Z'});
  const source={id:sourceId,courseId,sourceType:'assignment',sourceId:'42',title:'Tutorial 2',body:'Submit Tutorial 2',
    sourceUrl:`https://canvas.example/courses/${courseId}/assignments/42`,updatedAt:'2026-09-20T12:00:00Z',
    dueAt:'2026-09-25T23:59:00Z',unlockAt:null,lockAt:null};
  await kernel.ingestCanvasSource(source,null,'hash-1');
  await kernel.ingestCanvasSource(source,null,'hash-1');
  let tasks=await kernel.taskRows(courseId);
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].due_at,'2026-09-25T23:59:00.000Z');
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM source_item_versions WHERE source_item_id=$1',[sourceId])).rows[0].count),1);
  await kernel.completeSourceScan('canvas',courseId,[]);
  tasks=await kernel.taskRows(courseId);
  assert.equal(tasks[0].source_missing,true);
  assert.equal(tasks[0].due_at,'2026-09-25T23:59:00.000Z');
  await kernel.ingestCanvasSource({...source,body:'Tutorial 2 postponed; new deadline below',updatedAt:'2026-09-21T12:00:00Z',dueAt:'2026-09-30T23:59:00Z'},null,'hash-2');
  tasks=await kernel.taskRows(courseId);
  assert.equal(tasks[0].source_missing,false);
  assert.equal(tasks[0].due_at,'2026-09-30T23:59:00.000Z');
  assert.equal(tasks[0].cancelled_at,null);
  const emailId=`mail:${randomUUID()}`;
  await kernel.ingestMailAnalysis({id:emailId,account:'test@example.com',sender:'instructor@example.edu',
    subject:'Tutorial 2',body:'Tutorial 2 is cancelled',receivedAt:'2026-09-22T12:00:00Z',hash:randomUUID()},
    {deadlines:[],referencedUrls:[source.sourceUrl],actionItems:[{title:'Tutorial 2 cancelled',description:'No longer required',
      evidence:'Tutorial 2 is cancelled',confidence:0.99}]});
  const pending=(await kernel.pendingCandidates()).find(row=>row.attribute==='cancelled'&&row.entity_id===tasks[0].entity_id);
  assert.ok(pending);
  assert.equal((await kernel.taskRows(courseId))[0].cancelled_at,null);
  await kernel.adjudicate(pending.id,'accept','Confirmed against the instructor announcement','test-admin');
  assert.ok((await kernel.taskRows(courseId))[0].cancelled_at);
  assert.equal(Number((await kernelPool().query(
    `SELECT count(*) FROM fact_versions WHERE fact_id=(SELECT id FROM facts WHERE entity_id=$1 AND attribute='due')`,
    [tasks[0].entity_id])).rows[0].count),2);
});

test('persistent jobs recover expired leases and failed transactions roll back',async()=>{
  await migrateKernel();
  const key=`test-job:${randomUUID()}`;
  const id=await queueIngestionJob('test','test','unit',{value:1},key);
  assert.equal(await queueIngestionJob('test','test','unit',{value:1},key),id);
  const claimed=await claimIngestionJob();
  assert.equal(claimed?.id,id);
  await finishIngestionJob(id,claimed!.lease_token,'retry');
  const row=(await kernelPool().query('SELECT state,attempts FROM ingestion_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(row.state,'queued');
  assert.equal(row.attempts,1);
  const marker=`rollback:${randomUUID()}`;
  await assert.rejects(kernelTransaction(async client=>{
    await client.query(`INSERT INTO academic_terms(id,name) VALUES ($1,'test')`,[marker]);
    throw new Error('abort');
  }));
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM academic_terms WHERE id=$1',[marker])).rows[0].count),0);
});
