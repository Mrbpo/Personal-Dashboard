import {test,after} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {documentSourceName,safeAttachmentName} from '../lib/document-source-name.ts';import {documentTitleMention} from '../lib/kernel/document-source.ts';
const original="Generaci\\'on autom\\'atica de frases literarias en espa\\~nol.pdf",safe=safeAttachmentName(original);
test('source-name observation conserves exact spelling without changing the safe label or inventing aliases',()=>{
 const record=documentSourceName(safe,original)!;assert.equal(record.originalName,original);assert.equal(record.storageName,safe);
 assert.equal(documentTitleMention('关于论文《'+original.slice(0,-4)+'》',safe),null);
 assert.ok(documentTitleMention('关于论文《'+original.slice(0,-4)+'》',record.originalName));
 assert.deepEqual(documentSourceName(safe,undefined,JSON.parse(JSON.stringify(record))),record);
 assert.deepEqual(documentSourceName(original,undefined,{storageName:record.storageName,originalName:record.originalName,policy:record.policy}),record);
 assert.equal(JSON.stringify(documentSourceName(original,undefined,{storageName:record.storageName,originalName:record.originalName,policy:record.policy})),JSON.stringify(record));
 assert.equal(documentSourceName(safe),undefined,'Legacy names cannot be guessed from underscores');
 for(const invalid of [{...record,storageName:'unrelated.pdf'},{...record,extra:true},{...record,originalName:'bad\0name.pdf'}])assert.throws(()=>documentSourceName(safe,undefined,invalid));
 assert.throws(()=>documentSourceName('unrelated.pdf',original));assert.throws(()=>documentSourceName(safe,'x'.repeat(4001)));
});
const dir=mkdtempSync(join(tmpdir(),'source-name-'));process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=dir;
const {saveDocument,getDocument}=await import('../lib/library.ts');const {database}=await import('../lib/database.ts');const {enqueue}=await import('../lib/jobs.ts');
after(()=>rmSync(dir,{recursive:true,force:true}));
test('raw original name survives durable source and index queue storage while owners and first observations stay separate',async()=>{
 const bytes=Buffer.from('%PDF-1.4\nsource metadata fixture only'),id=await saveDocument('owner','','upload','name-test',safe,'application/pdf',bytes,'',original);
 await enqueue('index',{owner:'owner',id},'index:'+id);
 const job=await database.prepare('SELECT payload FROM background_jobs WHERE id=?').bind('index:'+id).first<{payload:string}>(),payload=JSON.parse(job!.payload),stored=await getDocument(payload.owner,payload.id);
 assert.equal(stored.name,safe);assert.equal(stored.original_name,original);assert.equal((await getDocument('owner',id)).original_name,original);
 await assert.rejects(()=>getDocument('foreign',id));
 assert.equal(await saveDocument('owner','','upload','name-test',safe,'application/pdf',bytes,'',original),id);
 const legacy=await saveDocument('owner','','upload','legacy',safe,'application/pdf',bytes);assert.equal((await getDocument('owner',legacy)).original_name,null);
 await assert.rejects(()=>saveDocument('owner','','upload','bad','unrelated.pdf','application/pdf',bytes,'',original));
});
