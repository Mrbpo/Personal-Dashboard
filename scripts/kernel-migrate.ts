import { database as legacy } from '../lib/database.ts';
import { kernel } from '../lib/kernel/service.ts';
import { kernelPool, migrateKernel } from '../lib/kernel/db.ts';
import {completeSourcePage} from '../lib/kernel/jobs.ts';

await migrateKernel();
if (!process.argv.includes('--import-legacy')) {
  console.log('Kernel schema is current. Pass --import-legacy to import the SQLite core snapshot.');
  process.exit(0);
}
if((await kernelPool().query("SELECT 1 FROM kernel_imports WHERE name='v0-final-snapshot'")).rowCount){
  console.log('Legacy core snapshot was already imported; leaving PostgreSQL facts unchanged.');
  await kernelPool().end();
  process.exit(0);
}

const courses=(await legacy.prepare('SELECT * FROM courses ORDER BY id').all<Record<string,unknown>>()).results;
const sources=(await legacy.prepare('SELECT * FROM source_items ORDER BY id').all<Record<string,unknown>>()).results;
const overrides=(await legacy.prepare('SELECT task_id,local_status FROM task_overrides').all<{task_id:string;local_status:string}>()).results;
const overrideByTask=new Map(overrides.map(row=>[row.task_id,row.local_status]));
const tasks=(await legacy.prepare('SELECT * FROM tasks ORDER BY id').all<Record<string,unknown>>()).results;
const events=(await legacy.prepare('SELECT * FROM schedule_events ORDER BY id').all<Record<string,unknown>>()).results;

for(const course of courses)await kernel.upsertCourse(course,'legacy_import');
for(const task of tasks)await kernel.importLegacyTask(task,overrideByTask.get(String(task.id)));
for(const source of sources)await kernel.importLegacySource(source);
for(const event of events)await kernel.ingestEvent(String(event.source_name),{
  uid:String(event.external_uid),title:String(event.title),description:String(event.description||''),
  startAt:String(event.start_at),endAt:String(event.end_at),allDay:Boolean(event.all_day),
},'legacy_import');
const mailCursors=(await legacy.prepare('SELECT account,history_id,page_token,pending_history,since_epoch FROM mail_sync').all<{
  account:string;history_id:string|null;page_token:string|null;pending_history:string|null;since_epoch:number}>()).results;
for(const cursor of mailCursors){
  if(await kernel.sourceCursor('gmail',cursor.account))continue;
  await completeSourcePage('gmail',cursor.account,JSON.stringify({history_id:cursor.history_id,
    page_token:cursor.page_token,pending_history:cursor.pending_history,since_epoch:cursor.since_epoch}),true);
}

const pg=kernelPool();
const counts={
  courses:Number((await pg.query('SELECT count(*) FROM courses')).rows[0].count),
  sources:Number((await pg.query("SELECT count(*) FROM source_items WHERE source='canvas' AND scope!='courses'")).rows[0].count),
  tasks:Number((await pg.query('SELECT count(*) FROM tasks')).rows[0].count),
  taskCandidates:Number((await pg.query("SELECT count(*) FROM candidate_facts WHERE attribute='task_payload'")).rows[0].count),
  events:Number((await pg.query('SELECT count(*) FROM events')).rows[0].count),
};
const expected={courses:courses.length,sources:sources.length,tasks:tasks.length,events:events.length};
console.log(JSON.stringify({expected,counts}));
if(counts.courses<expected.courses||counts.sources<expected.sources||counts.taskCandidates<expected.tasks||counts.events<expected.events){
  throw new Error('Kernel migration count mismatch; do not switch production traffic');
}
await pg.query("INSERT INTO kernel_imports(name,counts) VALUES ('v0-final-snapshot',$1) ON CONFLICT DO NOTHING",[JSON.stringify({expected,counts})]);
await pg.end();
