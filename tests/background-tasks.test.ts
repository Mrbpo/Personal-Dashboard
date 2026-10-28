import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.DATABASE_URL=':memory:';
const {backgroundTaskId,taskReason,readBackgroundSnapshot,backgroundStatus,triggerBackgroundTask}=await import('../lib/background-tasks.ts');
const {database:db}=await import('../lib/database.ts');

test('fixed task identifiers and safe errors cannot become arbitrary host units or secret output',()=>{
 for(const value of ['reboot','../../file','backup;exit',{task:'backup'}])assert.equal(backgroundTaskId.safeParse(value).success,false);
 assert.equal(taskReason('SUBTITLES_COMPLETED'),null);
 assert.equal(taskReason('private provider https://example.invalid/key'), '执行失败，请检查连接与任务记录');
});

test('whole pending subtitle and backup requests use the exclusive bridge without editing its queue',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'background-task-')),previous=process.env.COURSE_VIDEO_CONTROL_DIR;
 process.env.COURSE_VIDEO_CONTROL_DIR=directory;
 try{
  await mkdir(join(directory,'requests'));
  const at=new Date().toISOString(),host={configured:true,running:false,result:'success',enabled:true,startedAt:at,finishedAt:at,nextRunAt:at,lastRunAt:at};
  await writeFile(join(directory,'background-status.json'),JSON.stringify({schemaVersion:1,updatedAt:at,services:{subtitles:host,credentials:host,backup:host,status:host,recordings:host},parallel:{configured:2,admitted:1,active:0},
   subtitles:{total:1,unreadable:0,states:{failed:1},complete:0,englishComplete:1,published:0,resumable:1,items:[{videoSha256:'a'.repeat(64),courseId:'123',state:'failed',durationMs:1000,englishCoveredMs:1000,completedChunks:1,totalChunks:1,translatedCues:0,totalCues:1,published:false,partial:false,complete:false,resumable:true}]}}));
  const snapshot=await readBackgroundSnapshot();assert.equal(snapshot?.subtitles.complete,0);assert.equal(snapshot?.subtitles.englishComplete,1);
  const status=await backgroundStatus('local-owner');assert.equal(status.subtitles?.items.length,1);
  assert.deepEqual(await triggerBackgroundTask('local-owner','subtitles'),{accepted:true,existing:false});
  const request=JSON.parse(await readFile(join(directory,'requests/maintenance-request.json'),'utf8'));
  assert.equal(request.task,'subtitles');assert.deepEqual(Object.keys(request).sort(),['id','requestedAt','task']);
  assert.equal((await triggerBackgroundTask('local-owner','backup')).existing,true);
  assert.equal(JSON.parse(await readFile(join(directory,'requests/maintenance-request.json'),'utf8')).id,request.id);
  await assert.rejects(readFile(join(directory,'subtitle-queue.json')),{code:'ENOENT'});
  await writeFile(join(directory,'background-status.json'),'{}');assert.equal(await readBackgroundSnapshot(),null);
 }finally{if(previous===undefined)delete process.env.COURSE_VIDEO_CONTROL_DIR;else process.env.COURSE_VIDEO_CONTROL_DIR=previous;await rm(directory,{recursive:true,force:true});}
});

test('repeated manual nightly execution creates one durable job and preserves previous failures',async()=>{
 await db.prepare("INSERT OR REPLACE INTO worker_state(id,heartbeat,paused) VALUES ('primary',?,0)").bind(Date.now()).run();
 await db.prepare("INSERT INTO background_jobs(id,kind,payload,status,available_at,updated_at) VALUES ('old-night-failure','night','{}','failed',?,?)").bind(Date.now()-10000,Date.now()-10000).run();
 const results=await Promise.all([triggerBackgroundTask('local-owner','night'),triggerBackgroundTask('local-owner','night')]);
 assert.ok(results.some(row=>row.accepted));
 const count=await db.prepare("SELECT count(*) n FROM background_jobs WHERE kind='night' AND status='queued'").first<{n:number}>();
 assert.equal(count?.n,1);
 assert.equal((await db.prepare("SELECT count(*) n FROM background_jobs WHERE id='old-night-failure' AND status='failed'").first<{n:number}>())?.n,1);
 assert.equal((await triggerBackgroundTask('local-owner','night')).existing,true);
});

test('kernel fact maintenance manual requests deduplicate in PostgreSQL', {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernelPool}=await import('../lib/kernel/db.ts');
 const oldBackend=process.env.STUDY_ANSWER_BACKEND,oldEnabled=process.env.KERNEL_COURSE_FACTS_ENABLED;
 process.env.STUDY_ANSWER_BACKEND='kernel';process.env.KERNEL_COURSE_FACTS_ENABLED='true';
 try{
  await Promise.all([triggerBackgroundTask('local-owner','fact_validity_hourly'),triggerBackgroundTask('local-owner','fact_validity_hourly')]);
  assert.equal((await kernelPool().query("SELECT count(*)::int n FROM ingestion_jobs WHERE kind='fact_validity_hourly' AND state='queued'")).rows[0].n,1);
 }finally{if(oldBackend===undefined)delete process.env.STUDY_ANSWER_BACKEND;else process.env.STUDY_ANSWER_BACKEND=oldBackend;if(oldEnabled===undefined)delete process.env.KERNEL_COURSE_FACTS_ENABLED;else process.env.KERNEL_COURSE_FACTS_ENABLED=oldEnabled;}
});
