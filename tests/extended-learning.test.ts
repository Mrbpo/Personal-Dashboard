import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
process.env.DATABASE_URL=':memory:';process.env.LOCAL_OCR='false';
const {database:db}=await import('../lib/database.ts');
const {saveDocument,indexDocument,searchLibrary,canonicalDocumentMime,recordSourceFailure,listSourceFailures,clearSourceFailure}=await import('../lib/library.ts');
const {rollingMemory,relevantMemory}=await import('../lib/tutor-memory.ts');
const {tutorWeb,validatedPublicQuery}=await import('../lib/tutor-web.ts');
test('PDF page checkpoints resume after failure without reparsing completed pages',async()=>{
 const doc=await PDFDocument.create();doc.addPage();doc.addPage();const id=await saveDocument('alice','chem','upload','long.pdf','long.pdf','application/pdf',await doc.save());
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===2)return new Response(null,{status:503});return Response.json({output_text:JSON.stringify({text:'page text '+calls,complete:true})});};
 try{await assert.rejects(indexDocument('alice',id));await indexDocument('alice',id);assert.equal(calls,3);const pages=(await db.prepare('SELECT * FROM library_parse_pages WHERE document_id=? ORDER BY page').bind(id).all()).results;assert.equal(pages.length,2);assert.equal(pages[0].body,'page text 1');}finally{globalThis.fetch=original;}
});
test('PDF magic is normalized and archived text is searchable with a page locator',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 assert.equal(canonicalDocumentMime('slides.pdf','application/octet-stream',bytes),'application/pdf');
 const id=await saveDocument('search-owner','chem','upload','notes.txt','notes.txt','text/plain',Buffer.from('The limiting reagent determines the theoretical yield.'));
 await indexDocument('search-owner',id);
 const matches=await searchLibrary('search-owner','limiting reagent','chem',false);
 assert.equal(matches[0].document_id,id);assert.equal(matches[0].locator,'正文');
});
test('one unavailable remote file is recorded without hiding other archives',async()=>{
 await recordSourceFailure('failure-owner','canvas','remote-1','chem','missing.pdf','Canvas 未提供可下载地址');
 assert.equal((await listSourceFailures('failure-owner')).length,1);
 await clearSourceFailure('failure-owner','canvas','remote-1');
 assert.equal((await listSourceFailures('failure-owner')).length,0);
});
test('rolling memory advances incrementally and repeated reads reuse saved summary',async()=>{
 const history=Array.from({length:40},(_,i)=>({id:String(i),role:i%2?'assistant':'user',body:'message '+i,meta_json:'{}'}));const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:'Rolling summary '+calls});};
 try{assert.equal((await rollingMemory('alice','t',history)).through,12);assert.equal((await rollingMemory('alice','t',history)).through,16);assert.equal((await rollingMemory('alice','t',history)).through,16);assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
test('historical retrieval stays inside owner and course',async()=>{
 for(const [id,owner,course] of [['a','alice','chem'],['b','bob','chem'],['c','alice','stats']]){await db.prepare('INSERT INTO tutor_threads VALUES (?,?,?,?,?,?)').bind(id,owner,course,'Title','now','now').run();await db.prepare("INSERT INTO tutor_messages VALUES (?,?,'assistant','answer','[]',?,0,'now')").bind(id+'m',id,JSON.stringify({question:'concentration',takeaway:'molarity'})).run();}
 const results=await relevantMemory('alice','chem','concentration',[]);assert.equal(results.length,1);assert.equal(results[0].id,'am');
});
test('general web search sends only explicit public query and can be disabled',async()=>{
 assert.throws(()=>validatedPublicQuery('private@example.com'));
 const original=globalThis.fetch;let sent='';globalThis.fetch=async(_u,init)=>{sent=String(init?.body);return Response.json({output:[]});};
 try{await tutorWeb('PRIVATE MAIL BODY',true,'Nernst equation');assert.ok(sent.includes('Nernst equation'));assert.ok(!sent.includes('PRIVATE MAIL BODY'));sent='';await tutorWeb('PRIVATE MAIL BODY',false,'Nernst equation');assert.equal(sent,'');}finally{globalThis.fetch=original;}
});
