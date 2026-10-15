import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import type {CanvasSource} from '../lib/domain.ts';

process.env.DATABASE_URL=':memory:';
process.env.CANVAS_TOKEN='isolated-fixture-token';
process.env.OPENAI_API_KEY='';
const {getCourseSources}=await import('../lib/canvas.ts');
const {hashSource}=await import('../lib/repository.ts');
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
const network=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Real network/model access is prohibited in timezone fixtures');};
before(async()=>{
 const schema=process.env.KERNEL_SCHEMA??'',database=new URL(process.env.KERNEL_DATABASE_URL??'').pathname;
 if(process.env.CI==='true'&&/^kernel_test_\d+_\d+$/.test(schema))return;
 assert.equal(database,'/pdf_acceptance_20261006');assert.equal(schema,'truth_acceptance_timezone85_20261015_test');
 const admin=new Pool({connectionString:process.env.KERNEL_DATABASE_URL,max:1});
 try{
  assert.equal((await admin.query('SELECT current_database() name')).rows[0].name,'pdf_acceptance_20261006');
  assert.equal((await admin.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=$1',[schema])).rowCount,0,'Preserve prior focused runs; use an explicitly approved new schema');
  await admin.query(`CREATE SCHEMA ${schema}`);
 }finally{await admin.end();}
});
after(async()=>{globalThis.fetch=network;await kernelPool().end();});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const published='2026-09-21T12:00:00Z';
function source(courseId:string,id:number,dueAt:string,sourceTimezone:string|null='America/Toronto'):CanvasSource{
 return {id:`${courseId}:assignment:${id}`,courseId,sourceType:'assignment',sourceId:String(id),title:`Controlled timezone activity ${id}`,
  body:'Controlled synthetic timezone fixture; not a real course.',sourceUrl:`https://controlled-fixture.invalid/${courseId}/assignments/${id}`,
  updatedAt:published,dueAt,sourceTimezone,unlockAt:null,lockAt:null};
}
async function ingest(item:CanvasSource){await kernel.ingestCanvasSource(item,null,await hashSource(item));}
async function task(item:CanvasSource){return (await kernel.taskRows(item.courseId,true)).find(row=>row.id===item.id+':0')!;}
async function pending(item:CanvasSource){return (await kernel.pendingCandidates()).find(row=>row.task_id===item.id+':0'&&row.attribute==='due');}

test('fetched Canvas timezone reaches source hash, evidence, canonical projection and real hour precision',async()=>{
 await migrateKernel();
 const courseId=`tz85-adapter:${randomUUID()}`,zone='America/Toronto';
 await kernel.upsertCourse({id:courseId,name:'Controlled adapter course',course_code:courseId,time_zone:zone});
 const assignments=[['2027-06-19T02:15Z','minute'],['2027-06-18','date'],['2027-07-10T13Z','hour'],
  ['2027-07-10T13-04:00','hour'],['2027-07-10T21:05:07-04:00','second']];
 globalThis.fetch=async(input)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/assignments'))return Response.json(assignments.map(([due_at],i)=>({id:i+1,name:`Controlled ${i+1}`,description:'Controlled fixture',due_at,updated_at:published})));
  if(url.pathname===`/api/v1/courses/${courseId}`)return Response.json({time_zone:zone});
  return Response.json([]);
 };
 let sources:CanvasSource[];
 try{({sources}=await getCourseSources(courseId));}finally{globalThis.fetch=async()=>{throw new Error('Real network/model access is prohibited');};}
 assert.equal(sources.length,5);assert.ok(sources.every(item=>item.sourceTimezone===zone));
 for(const item of sources)await ingest(item);
 const rows=await kernel.taskRows(courseId,true),byId=new Map(rows.map(row=>[row.id,row]));
 const minute=byId.get(sources[0].id+':0')!;
 assert.deepEqual([minute.due_date,minute.due_at,minute.due_local_time,minute.due_timezone,minute.due_precision],
  ['2027-06-18','2027-06-19T02:15:00.000Z','22:15:00',zone,'minute']);
 const date=byId.get(sources[1].id+':0')!;
 assert.deepEqual([date.due_date,date.due_local_time,date.due_timezone,date.due_precision],['2027-06-18',null,null,'date']);
 assert.equal((await kernelPool().query('SELECT due_at FROM tasks WHERE id=$1',[date.id])).rows[0].due_at,null);
 assert.deepEqual([byId.get(sources[2].id+':0')!.due_at,byId.get(sources[2].id+':0')!.due_precision],['2027-07-10T13:00:00.000Z','hour']);
 assert.deepEqual([byId.get(sources[3].id+':0')!.due_at,byId.get(sources[3].id+':0')!.due_precision],['2027-07-10T17:00:00.000Z','hour']);
 assert.deepEqual([byId.get(sources[4].id+':0')!.due_at,byId.get(sources[4].id+':0')!.due_precision],['2027-07-11T01:05:07.000Z','second']);
 const ev=(await kernel.canonicalEvidence([], [minute.id], [])).find(row=>row.attribute==='due')!;
 assert.equal(ev.original_excerpt,'2027-06-19T02:15Z');assert.equal(ev.confidence,1);assert.ok(ev.acquired_at);
 const firstHash=await hashSource(sources[0]);await ingest(sources[0]);
 const changed={...sources[0],sourceTimezone:'America/Vancouver',updatedAt:'2026-09-22T12:00:00Z'};
 assert.notEqual(await hashSource(changed),firstHash);await ingest(changed);
 assert.deepEqual([(await task(changed)).due_timezone,(await task(changed)).due_local_time],['America/Vancouver','19:15:00']);
 const versions=(await kernelPool().query('SELECT raw_value FROM source_item_versions WHERE source_item_id=$1',[changed.id])).rows;
 assert.equal(versions.length,2);assert.deepEqual(versions.map(row=>row.raw_value.sourceTimezone).sort(),['America/Toronto','America/Vancouver']);
 assert.ok((await kernel.canonicalEvidence([courseId],[],[])).some(row=>row.original_excerpt.includes('America/Toronto')));
});

test('invalid zones, offset disagreement, DST local fold/gap and invalid calendar dates stay candidates',async()=>{
 await migrateKernel();const courseId=`tz85-unresolved:${randomUUID()}`;
 await kernel.upsertCourse({id:courseId,name:'Controlled unresolved course',course_code:courseId});
 const bad:[string,string|null][]=[['2027-06-19T02:15Z','Unknown/Fixture'],['2027-07-10T13-05:00','America/Toronto'],
  ['2026-11-01T01:30','America/Toronto'],['2026-03-08T02:30','America/Toronto'],['2026-02-30T13Z','Etc/UTC'],['2027-07-10T13-04:00',null]];
 for(const [index,[raw,zone]] of bad.entries()){
  const item=source(courseId,index+101,raw,zone);await ingest(item);
  assert.equal((await task(item)).due_precision,null);assert.equal((await task(item)).due_at,null);
  const candidate=await pending(item);assert.ok(candidate);assert.equal(candidate.value.original,raw);assert.equal(candidate.value.precision,null);
  assert.equal((await kernel.canonicalEvidence([], [item.id+':0'], [])).filter(row=>row.attribute==='due').length,0);
 }
 const utc=source(courseId,201,'2027-07-10T13Z',null);await ingest(utc);
 assert.deepEqual([(await task(utc)).due_timezone,(await task(utc)).due_at,(await task(utc)).due_precision],['Etc/UTC','2027-07-10T13:00:00.000Z','hour']);
 const ai=source(courseId,202,'2027-07-10','America/Toronto');
 await kernel.ingestCanvasSource(ai,{summary:'Controlled fixture',notes:[],actions:[{title:ai.title,action:'Controlled action',requirements:[],
  recommendedStartAt:null,inferredDueAt:'2027-07-10T13Z',confidence:'certain',evidence:ai.body,estimatedMinutes:null,possiblyCancelled:false}]},await hashSource(ai));
 assert.ok((await kernel.pendingCandidates()).some(row=>row.task_id===ai.id+':0'&&row.attribute==='due'&&row.value.timezone==='America/Toronto'&&row.value.precision==='hour'));
});

test('mail zone requires original-body direct pairing, with no trusted AI-only or ambiguous zone',async()=>{
 await migrateKernel();const courseId=`tz85-mail:${randomUUID()}`,account=`${courseId}@example.invalid`,at='2027-08-05T12:45:00Z',zone='America/Toronto';
 await kernel.upsertCourse({id:courseId,name:'Controlled mail course',course_code:courseId});
 const item=source(courseId,301,'2027-08-01');await ingest(item);
 const body=`Controlled synthetic fixture: deadline ${at} (${zone}).`,mail={id:'supported',account,sender:'controlled@example.invalid',subject:'Controlled deadline',body,receivedAt:published,hash:hash(body)};
 const analysis={deadlines:[{at,text:body,evidence:body,confidence:.99,sourceTimezone:zone}],referencedUrls:[item.sourceUrl!]};
 await kernel.ingestMailAnalysis(mail,analysis);let p=await pending(item);assert.ok(p);assert.equal(p.value.timezone,zone);
 assert.equal((await task(item)).due_precision,'date');
 await kernel.adjudicate(p.id,'accept','Controlled original source pair verified','timezone-test-reviewer');
 assert.deepEqual([(await task(item)).due_at,(await task(item)).due_timezone,(await task(item)).due_local_time],['2027-08-05T12:45:00.000Z',zone,'08:45:00']);
 const altered={...analysis,deadlines:[{...analysis.deadlines[0],sourceTimezone:'Europe/Berlin'}]};
 await kernel.ingestMailAnalysis(mail,altered);await kernel.ingestMailAnalysis(mail,altered);
 p=await pending(item);assert.ok(p);assert.equal(p.value.precision,null);
 await assert.rejects(kernel.adjudicate(p.id,'accept','AI-only zone is not source proof','timezone-test-reviewer'),/unambiguous/);
 assert.equal((await task(item)).due_timezone,zone);
 const versions=(await kernelPool().query('SELECT raw_value FROM source_item_versions WHERE source_item_id=$1',[`gmail:${account}:supported`])).rows;
 assert.equal(versions.length,2);assert.ok(versions.some(row=>row.raw_value.deadlineSources[0].sourceTimezoneVerified===true));
 assert.ok(versions.some(row=>row.raw_value.deadlineSources[0].sourceTimezoneVerified===false));
 const unsupported=[
  {body:`Controlled synthetic fixture: deadline ${at}.`,evidence:`Controlled synthetic fixture: deadline ${at}.`},
  {body:'Controlled synthetic fixture: next Thursday at noon Toronto time.',evidence:'Controlled synthetic fixture: next Thursday at noon Toronto time.'},
  {body,evidence:`"${body}"`},
  {body:`${at} (${zone}) and ${at} (Europe/Berlin)`,evidence:`${at} (${zone})`},
  {body:`${at} (${zone}) and 2027-08-06T12:45:00Z (Europe/Berlin)`,evidence:`${at} (${zone}) and 2027-08-06T12:45:00Z (Europe/Berlin)`},
 ];
 for(const [i,value] of unsupported.entries()){
  const id=`unsupported-${i}`;await kernel.ingestMailAnalysis({...mail,id,body:value.body,hash:hash(value.body)},
   {deadlines:[{...analysis.deadlines[0],evidence:value.evidence,text:value.body}]});
  const row=(await kernel.pendingCandidates()).find(row=>row.entity_kind==='mail_claim'&&row.original_excerpt===value.evidence);
  assert.ok(row);assert.equal(row.value.precision,null);
 }
});

test('legacy import retains its recorded timezone without inventing a source or changing date precision',async()=>{
 await migrateKernel();const courseId=`tz85-legacy:${randomUUID()}`,sourceItemId=`${courseId}:assignment:401`;
 await kernel.upsertCourse({id:courseId,name:'Controlled legacy course',course_code:courseId},'legacy_import');
 const row={id:sourceItemId+':0',course_id:courseId,source_item_id:sourceItemId,source_type:'assignment',source_id:'401',
  source_url:null,title:'Controlled imported activity',action:'Complete controlled import',requirements_json:'[]',
  start_at:null,due_at:'2027-07-10T13-04:00',due_timezone:'America/Toronto',unlock_at:null,lock_at:null,
  canvas_status:'upcoming',urgency:'upcoming',confidence:'certain',evidence:'Controlled original legacy row',
  estimated_minutes:10,points_possible:1,prerequisite_blocked:0,updated_at:published};
 await kernel.importLegacyTask(row);await kernel.importLegacyTask(row);
 const actual=(await kernel.taskRows(courseId))[0];
 assert.deepEqual([actual.due_at,actual.due_timezone,actual.due_local_time,actual.due_precision],
  ['2027-07-10T17:00:00.000Z','America/Toronto','13:00:00','hour']);
 const ev=(await kernel.canonicalEvidence([], [actual.id], [])).find(item=>item.attribute==='due')!;
 assert.equal(ev.source,'legacy_import');assert.equal(ev.original_excerpt,row.due_at);
 assert.equal((await kernelPool().query('SELECT count(*)::integer n FROM source_item_versions WHERE source_item_id=$1',[sourceItemId])).rows[0].n,1);
});
