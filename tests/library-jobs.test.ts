import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
process.env.DATABASE_URL=':memory:';
const {database:db}=await import('../lib/database.ts');
const lib=await import('../lib/library.ts');
const jobs=await import('../lib/jobs.ts');
const parser=await import('../lib/document-parser.ts');
test('DOCX text is extracted locally without an AI request',async()=>{
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.folder('_rels')!.file('.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.folder('word')!.file('document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>CHMA10 notebook preparation</w:t></w:r></w:p></w:body></w:document>');
 const bytes=await zip.generateAsync({type:'nodebuffer'});
 assert.equal(await parser.extractDocxText(bytes),'CHMA10 notebook preparation');
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('DOCX local parsing must not call AI');};
 try{
  const id=await lib.saveDocument('docx-owner','','upload','notes.docx','notes.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes);
  await lib.indexDocument('docx-owner',id);
  const hits=await lib.searchLibrary('docx-owner','notebook preparation','',false);
  assert.equal(hits[0]?.locator,'正文');
 }finally{globalThis.fetch=original;}
});
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
test('terminal document jobs can be revived without disturbing an active lease',async()=>{
 await jobs.enqueue('index',{id:'doc-a'},'index:doc-a');
 const first=await jobs.claimJob();assert.equal(first?.id,'index:doc-a');
 await jobs.finishJob(first!.id,first!.lease_token,'failed once');
 await jobs.enqueue('index',{id:'doc-a'},'index:doc-a',true);
 const retried=await jobs.claimJob();assert.equal(retried?.id,'index:doc-a');assert.equal(retried?.attempts,1);
 await jobs.enqueue('index',{id:'doc-a'},'index:doc-a',true);
 assert.equal((await db.prepare('SELECT status FROM background_jobs WHERE id=?').bind('index:doc-a').first<{status:string}>())?.status,'running');
 await jobs.finishJob(retried!.id,retried!.lease_token);
});
test('source synchronization is not starved by an indexing backlog',async()=>{
 await jobs.enqueue('index',{id:'slow'},'index:slow');
 await jobs.enqueue('canvas',{},'canvas:priority');
 const first=await jobs.claimJob();assert.equal(first?.id,'canvas:priority');
 await jobs.finishJob(first!.id,first!.lease_token);
 const second=await jobs.claimJob();assert.equal(second?.id,'index:slow');
 await jobs.finishJob(second!.id,second!.lease_token);
});
test('primary lease and Toronto 03:00 scheduling survive daylight-saving boundaries',async()=>{
 assert.equal(await jobs.acquireLease('x','a',100,100),true);assert.equal(await jobs.acquireLease('x','b',150,100),false);assert.equal(await jobs.acquireLease('x','b',201,100),true);
 assert.equal(jobs.nightKey(new Date('2026-09-15T06:59:00Z')),null);
 assert.equal(jobs.nightKey(new Date('2026-09-15T07:00:00Z')),'2026-09-15');
 assert.equal(jobs.nightKey(new Date('2026-11-01T07:59:00Z')),null);
 assert.equal(jobs.nightKey(new Date('2026-11-01T08:00:00Z')),'2026-11-01');
});
