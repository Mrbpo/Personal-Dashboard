import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {SingleJobSlot,dispatchWorkerTurn} from '../lib/kernel/worker-slot.ts';
import {AiBudgetDeferredError,nextBudgetMonth,reserveBudget} from '../lib/ai-budget.ts';
import {database} from '../lib/database.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {kernel} from '../lib/kernel/service.ts';
import {claimIngestionJob,deferIngestionJob,finishIngestionJob,hasRunningIngestionJob,queueIngestionJob} from '../lib/kernel/jobs.ts';

after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});

test('a blocked Docling slot permits bounded Outbox/vector work and drains safely',async()=>{
 const slot=new SingleJobSlot(),events:string[]=[];
 let finish!:()=>void;
 const blocked=new Promise<void>(resolve=>{finish=resolve;});
 const run=async(job:{kind:string})=>{events.push(job.kind);if(job.kind==='docling_document')await blocked;};
 let next={kind:'docling_document'},excluded:string[]=[];
 const operations={canClaim:()=>true,runOneOutbox:async()=>{events.push('outbox');},hasActiveDocling:async()=>false,
  claim:async(kinds:string[])=>{excluded=kinds;return next;},run,onUnexpectedError:()=>{throw new Error('Unexpected run failure');}};
 await dispatchWorkerTurn(slot,operations);await Promise.resolve();
 assert.equal(slot.busy,true);assert.equal(await slot.drain(1),false);
 next={kind:'document_vectors'};await dispatchWorkerTurn(slot,operations);
 assert.deepEqual(excluded,['docling_document']);assert.deepEqual(events,['outbox','docling_document','outbox','document_vectors']);
 assert.equal(slot.start(async()=>{},()=>{}),false,'the process cannot start a second slot');
 await dispatchWorkerTurn(slot,{...operations,canClaim:()=>false});
 assert.equal(events.length,4,'primary loss must not run Outbox or claim another job');
 finish();assert.equal(await slot.drain(100),true);assert.equal(slot.busy,false);
 let failures=0;slot.start(async()=>{throw new Error('Controlled failure');},()=>{failures++;});
 assert.equal(await slot.drain(100),true);assert.equal(failures,1);assert.equal(slot.busy,false);
});

test('quota refusal adds no ledger entry and uses the actual UTC/Toronto reset',async()=>{
 assert.equal(nextBudgetMonth(new Date('2026-10-14T12:00:00Z')).toISOString(),'2026-11-01T04:00:00.000Z');
 assert.equal(nextBudgetMonth(new Date('2026-11-14T12:00:00Z')).toISOString(),'2026-12-01T05:00:00.000Z');
 const previous=process.env.AI_MONTHLY_BUDGET;process.env.AI_MONTHLY_BUDGET='0.03';
 try{
  const kind=`quota-test-${randomUUID()}`;
  await reserveBudget(.01,kind,1);
  await assert.rejects(reserveBudget(.001,kind,1),error=>error instanceof AiBudgetDeferredError&&error.reason==='daily'&&
   error.retryAt.getTime()===Math.floor(Date.now()/86400000)*86400000+86400000);
  await assert.rejects(reserveBudget(.04,kind,1),error=>error instanceof AiBudgetDeferredError&&error.reason==='monthly'&&
   error.retryAt.getTime()>=nextBudgetMonth(new Date()).getTime());
  assert.equal(Number((await database.prepare('SELECT count(*) n FROM ai_ledger WHERE kind=?').bind(kind).first<{n:number}>())!.n),1);
 }finally{if(previous===undefined)delete process.env.AI_MONTHLY_BUDGET;else process.env.AI_MONTHLY_BUDGET=previous;}
});

test('durable slot exclusion and budget deferral preserve checkpoints, attempts and historical failed vectors',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),tag=randomUUID();
 const first=await queueIngestionJob('docling_document','test',tag,{owner:tag,id:tag,doclingTaskId:'saved-task',doclingProgress:{batches:[{resultHash:'saved-result'}]}},`first-${tag}`);
 const active=(await claimIngestionJob(first))!;
 const other=await queueIngestionJob('docling_document','test',tag,{},`other-${tag}`);
 const vector=await queueIngestionJob('document_vectors','test',tag,{pageCursor:32},`vector-${tag}`);
 assert.equal(await hasRunningIngestionJob('docling_document'),true);
 const selected=(await claimIngestionJob(undefined,['docling_document']))!;
 assert.equal(selected.id,vector,'a running long conversion cannot block another kind');
 const at=new Date(Date.now()+86400000);
 assert.equal(await deferIngestionJob(selected.id,selected.lease_token,at,'daily'),true);
 const deferred=(await pool.query('SELECT state,attempts,payload,stage,lease_token,available_at FROM ingestion_jobs WHERE id=$1',[vector])).rows[0];
 assert.equal(deferred.state,'queued');assert.equal(deferred.attempts,0);assert.equal(deferred.payload.pageCursor,32);
 assert.equal(deferred.lease_token,null);assert.ok(new Date(deferred.available_at).getTime()>=at.getTime());
 assert.equal(await deferIngestionJob(selected.id,selected.lease_token,at,'daily'),false,'a stale executor cannot mutate a new lease');
 await pool.query("UPDATE ingestion_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[first]);
 const resumed=(await claimIngestionJob(first))!;
 assert.notEqual(resumed.lease_token,active.lease_token);assert.deepEqual(resumed.payload,active.payload,'remote ID and committed checkpoint survive restart');
 await finishIngestionJob(resumed.id,resumed.lease_token);
 assert.equal((await claimIngestionJob(other))!.id,other);
 const owner=`failed-vector-${tag}`,id=`document-${tag}`;
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Fixture.pdf',hash:createHash('sha256').update(tag).digest('hex'),mime:'application/pdf',origin:'upload',originKey:id},
  [{locator:'Page 1',text:'An unchanged example lesson.'}],{parserVersion:'test'});
 const [failed]=await kernel.queueDocumentVectorJobs(owner);
 await pool.query("UPDATE ingestion_jobs SET state='failed',attempts=5,last_error='old failure' WHERE id=$1",[failed]);
 assert.deepEqual(await kernel.queueDocumentVectorJobs(owner),[]);
 assert.equal((await pool.query('SELECT state,attempts FROM ingestion_jobs WHERE id=$1',[failed])).rows[0].state,'failed');
 assert.equal((await pool.query('SELECT attempts FROM ingestion_jobs WHERE id=$1',[failed])).rows[0].attempts,5);
});
