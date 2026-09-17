import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
const {database:db}=await import('../lib/database.ts');
const lib=await import('../lib/library.ts');
const jobs=await import('../lib/jobs.ts');
test('library versions isolate owners and courses, deduplicate and hide deletions',async()=>{
 await db.prepare("INSERT INTO courses (id,name,code,updated_at) VALUES ('chem','Chemistry','CHMA10H3','now'),('stats','Statistics','STAB22H3','now')").run();
 const first=await lib.saveDocument('alice','chem','upload','notes.txt','notes.txt','text/plain',Buffer.from('molarity first'));
 assert.equal(first,await lib.saveDocument('alice','chem','upload','notes.txt','notes.txt','text/plain',Buffer.from('molarity first')));
 const other=await lib.saveDocument('alice','stats','upload','notes.txt','notes.txt','text/plain',Buffer.from('molarity first'));
 assert.notEqual(first,other);
 const second=await lib.saveDocument('alice','chem','upload','notes.txt','notes.txt','text/plain',Buffer.from('molarity revised'));
 await Promise.all([lib.indexDocument('alice',first),lib.indexDocument('alice',other),lib.indexDocument('alice',second)]);
 assert.equal((await lib.listDocuments('alice')).length,3);
 assert.equal((await lib.searchLibrary('bob','molarity','',false)).length,0);
 await assert.rejects(lib.getDocument('bob',first));
 const hits=await lib.searchLibrary('alice','CHMA10 molarity','',false);
 assert.equal(hits.length,1);assert.equal(hits[0].document_id,second);
 assert.equal((await lib.searchLibrary('alice','ZZZZ99 molarity','',false)).length,0);
 await lib.removeDocument('alice',second);
 assert.ok(!(await lib.searchLibrary('alice','molarity','chem',false)).some(h=>h.document_id===second));
 await assert.rejects(lib.getDocument('alice',second));
});
test('embedding unchanged chunks avoids duplicate calls, including concurrent requests',async()=>{
 let calls=0;const original=globalThis.fetch;
 globalThis.fetch=async(_u,init)=>{calls++;const b=JSON.parse(String(init?.body));return Response.json({data:b.input.map((_:unknown,index:number)=>({index,embedding:Array(768).fill(0.1)}))});};
 try{await Promise.all([lib.embedMissing('alice'),lib.embedMissing('alice')]);assert.equal(calls,1);await lib.embedMissing('alice');assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('job leases recover and stale executors cannot finish reclaimed jobs',async()=>{
 await jobs.enqueue('night',{},'night-test');await jobs.enqueue('night',{},'night-test');
 const [a,b]=await Promise.all([jobs.claimJob(),jobs.claimJob()]);assert.ok(Boolean(a)!==Boolean(b));const current=(a||b)!;
 const reclaimed=await jobs.claimJob(Date.now()+180001);assert.equal(reclaimed?.id,current.id);assert.notEqual(reclaimed?.lease_token,current.lease_token);
 await jobs.finishJob(current.id,current.lease_token);
 assert.equal((await db.prepare('SELECT status FROM background_jobs WHERE id=?').bind(current.id).first<{status:string}>())?.status,'running');
 await jobs.finishJob(current.id,reclaimed!.lease_token);assert.equal(await jobs.claimJob(),null);
});
test('primary lease and Toronto 03:00 scheduling survive daylight-saving boundaries',async()=>{
 assert.equal(await jobs.acquireLease('x','a',100,100),true);assert.equal(await jobs.acquireLease('x','b',150,100),false);assert.equal(await jobs.acquireLease('x','b',201,100),true);
 assert.equal(jobs.nightKey(new Date('2026-09-15T06:59:00Z')),null);
 assert.equal(jobs.nightKey(new Date('2026-09-15T07:00:00Z')),'2026-09-15');
 assert.equal(jobs.nightKey(new Date('2026-11-01T07:59:00Z')),null);
 assert.equal(jobs.nightKey(new Date('2026-11-01T08:00:00Z')),'2026-11-01');
});
