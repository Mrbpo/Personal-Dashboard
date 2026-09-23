import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

process.env.DATABASE_URL=':memory:';
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_API_KEY='test-key';
process.env.AI_MONTHLY_BUDGET='1';

const {database:db}=await import('../lib/database.ts');
const {backfillMailEmbeddings,mailEmbeddingCoverage,MAIL_EMBED_VERSION,EMBED_MODEL}=await import('../lib/mail-embedding.ts');
const hash=(subject:string,body:string)=>createHash('sha256').update(subject+body).digest('hex');

async function seed(id:string,receivedAt:string){
 const subject=`Subject ${id}`,body=`Body ${id} with a useful fact.`,sourceHash=hash(subject,body);
 await db.prepare('INSERT INTO mail_messages(id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .bind(id,'test@example.invalid',id,subject,'sender@example.invalid',body,receivedAt,'学习','[]',sourceHash).run();
 const oldVector=JSON.stringify(Array(768).fill(.2));
 await db.prepare('INSERT INTO mail_embeddings VALUES (?,?,?,?,?)').bind(id,EMBED_MODEL,'legacy-hash',oldVector,'now').run();
 return {sourceHash,oldVector};
}

test('backfill is capped, resumable, and preserves old vectors on failure',async()=>{
 const original=globalThis.fetch;
 const seeded=await Promise.all([
  seed('mail-1','2026-09-23T03:00:00Z'),seed('mail-2','2026-09-23T02:00:00Z'),seed('mail-3','2026-09-23T01:00:00Z'),
 ]);
 let calls=0;
 globalThis.fetch=async(_url,init)=>{
  calls++;
  const input=JSON.parse(String(init?.body)).input as string[];
  return Response.json({data:input.map((_,index)=>({index,embedding:Array(768).fill(.1)}))});
 };
 try{
  const options={limit:2,batchSize:2,maxReservedUsd:.01};
  const dry=await backfillMailEmbeddings({...options,apply:false});
  assert.equal(dry.selected,2);assert.equal(dry.written,0);assert.equal(dry.before.stale,3);assert.equal(calls,0);
  const capped=await backfillMailEmbeddings({...options,maxReservedUsd:.000001,apply:false});
  assert.equal(capped.selected,0);assert.equal(capped.stopped,'run_cost_cap');
  process.env.AI_MONTHLY_BUDGET='0';
  const outOfBudget=await backfillMailEmbeddings({...options,apply:false});
  assert.equal(outOfBudget.selected,0);assert.equal(outOfBudget.stopped,'monthly_budget');
  process.env.AI_MONTHLY_BUDGET='1';
  globalThis.fetch=async()=>Response.json({error:'temporary'},{status:503});
  await assert.rejects(backfillMailEmbeddings({...options,apply:true}),/邮件向量索引失败/);
  assert.deepEqual((await db.prepare('SELECT input_hash,vector FROM mail_embeddings WHERE email_id=?').bind('mail-1').first()),{input_hash:'legacy-hash',vector:seeded[0].oldVector});
  assert.equal((await mailEmbeddingCoverage()).stale,3);
  globalThis.fetch=async(_url,init)=>{
   calls++;
   const input=JSON.parse(String(init?.body)).input as string[];
   return Response.json({data:input.map((_,index)=>({index,embedding:Array(768).fill(.1)}))});
  };
  const first=await backfillMailEmbeddings({...options,apply:true});
  assert.equal(first.written,2);assert.equal(first.after.stale,1);
  assert.equal((await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=?').bind('mail-1').first<{input_hash:string}>())?.input_hash,MAIL_EMBED_VERSION+seeded[0].sourceHash);
  const second=await backfillMailEmbeddings({...options,apply:true});
  assert.equal(second.written,1);assert.equal(second.after.stale,0);
  const done=await backfillMailEmbeddings({...options,apply:true});
  assert.equal(done.selected,0);assert.equal(done.written,0);
 }finally{globalThis.fetch=original;}
});

test('a mail changed during the paid request cannot receive an obsolete embedding',async()=>{
 const original=globalThis.fetch,{oldVector}=await seed('mail-race','2026-09-23T04:00:00Z');
 globalThis.fetch=async(_url,init)=>{
  const input=JSON.parse(String(init?.body)).input as string[];
  const subject='Subject mail-race',body='Updated during the request.';
  await db.prepare('UPDATE mail_messages SET body=?,hash=? WHERE id=?').bind(body,hash(subject,body),'mail-race').run();
  return Response.json({data:input.map((_,index)=>({index,embedding:Array(768).fill(.3)}))});
 };
 try{
  const result=await backfillMailEmbeddings({limit:1,batchSize:1,maxReservedUsd:.01,apply:true});
  assert.equal(result.written,0);assert.equal(result.stopped,'busy_or_changed');
  assert.deepEqual((await db.prepare('SELECT input_hash,vector FROM mail_embeddings WHERE email_id=?').bind('mail-race').first()),{input_hash:'legacy-hash',vector:oldVector});
  assert.equal(result.after.stale,1);
  await db.prepare('UPDATE mail_messages SET removed=1 WHERE id=?').bind('mail-race').run();
  const coverage=await mailEmbeddingCoverage();
  assert.equal(coverage.stale,0);assert.equal(coverage.orphan,1);
  assert.equal((await backfillMailEmbeddings({limit:1,batchSize:1,maxReservedUsd:.01,apply:false})).selected,0);
 }finally{globalThis.fetch=original;}
});

test('a partly written batch leaves changed rows for the next run',async()=>{
 const original=globalThis.fetch;
 const first=await seed('partial-1','2026-09-23T06:00:00Z');
 await seed('partial-2','2026-09-23T05:00:00Z');
 let changeDuringRequest=true;
 globalThis.fetch=async(_url,init)=>{
  const input=JSON.parse(String(init?.body)).input as string[];
  if(changeDuringRequest){
   changeDuringRequest=false;
   const subject='Subject partial-1',body='New body after sync.';
   await db.prepare('UPDATE mail_messages SET body=?,hash=? WHERE id=?').bind(body,hash(subject,body),'partial-1').run();
  }
  return Response.json({data:input.map((_,index)=>({index,embedding:Array(768).fill(.4)}))});
 };
 try{
  const options={limit:2,batchSize:2,maxReservedUsd:.01,apply:true};
  const partial=await backfillMailEmbeddings(options);
  assert.equal(partial.written,1);assert.equal(partial.after.stale,1);
  assert.equal((await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=?').bind('partial-1').first<{input_hash:string}>())?.input_hash,'legacy-hash');
  assert.equal((await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=?').bind('partial-2').first<{input_hash:string}>())?.input_hash,MAIL_EMBED_VERSION+hash('Subject partial-2','Body partial-2 with a useful fact.'));
  const resumed=await backfillMailEmbeddings(options);
  assert.equal(resumed.written,1);assert.equal(resumed.after.stale,0);
  assert.notEqual((await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=?').bind('partial-1').first<{input_hash:string}>())?.input_hash,MAIL_EMBED_VERSION+first.sourceHash);
 }finally{globalThis.fetch=original;}
});
