import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
const {database:db}=await import('../lib/database.ts');
const {saveIntegrationConnection}=await import('../lib/repository.ts');
const {mailPage,analyzeMailThread}=await import('../lib/mail-threads.ts');
test('mail pagination covers all archives and literal search stays inside account',async()=>{
 await saveIntegrationConnection('gmail','test',{owner:'alice',email:'test@example.invalid'});
 await db.batch(Array.from({length:105},(_,i)=>db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(String(i).padStart(3,'0'),'test@example.invalid','t','Topic '+i,'sender','Body 100% literal','2026-09-15','其他','[]','h'+i)));
 const first=await mailPage('alice'),second=await mailPage('alice',{before:first.next!});assert.equal(first.messages.length,100);assert.equal(second.messages.length,5);assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,105);
 assert.equal((await mailPage('bob')).messages.length,0);assert.equal((await mailPage('alice',{query:'100%'})).messages.length,100);assert.equal((await mailPage('alice',{query:'100_'})).messages.length,0);
});
test('thread summaries reuse fingerprints and refresh when messages change',async()=>{
 let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({summary:'Thread summary',suggestions:['Review'],conflicts:[]})});};
 try{await assert.rejects(analyzeMailThread('bob','t'));await analyzeMailThread('alice','t');await analyzeMailThread('alice','t');assert.equal(calls,1);await db.prepare("UPDATE mail_messages SET hash='changed',body='Updated' WHERE id='000'").run();await analyzeMailThread('alice','t');assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
