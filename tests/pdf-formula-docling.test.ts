import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';

process.env.DATABASE_URL=':memory:';
const directory=mkdtempSync(join(tmpdir(),'docling-reparse-'));
process.env.LIBRARY_DIR=directory;
after(()=>rmSync(directory,{recursive:true,force:true}));

test('failed replacement keeps prior searchable pages and chunks; first parse failure remains error',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument,getDocument}=await import('../lib/library.ts');
 const {recordDoclingParseFailure}=await import('../lib/pdf-formula-reparse.ts');
 const pdf=await PDFDocument.create();pdf.addPage();
 const bytes=await pdf.save();
 const previous=await saveDocument('failed-owner','math','upload','previous.pdf','previous.pdf','application/pdf',bytes);
 const first=await saveDocument('failed-owner','math','upload','first.pdf','first.pdf','application/pdf',bytes);
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'docling-v1', 0, ?)").bind(previous,'Previously verified text').run();
 await db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(`${previous}:0`,previous,0,'第 1 页','Previously verified text','previous-hash').run();
 await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(previous).run();
 await recordDoclingParseFailure(previous);
 assert.equal((await getDocument('failed-owner',previous)).status,'ready');
 assert.match((await getDocument('failed-owner',previous)).error||'',/已保留/);
 assert.equal((await db.prepare('SELECT body FROM library_chunks WHERE document_id=?').bind(previous).first<{body:string}>())?.body,'Previously verified text');
 await recordDoclingParseFailure(first);
 assert.equal((await getDocument('failed-owner',first)).status,'error');
});

test('a resumed conversion uses its durable Docling task and rejects a stale lease',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {randomUUID}=await import('node:crypto');
 const {queueIngestionJob,rememberDoclingTask}=await import('../lib/kernel/jobs.ts');
 const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
 const {saveDocument}=await import('../lib/library.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
 const priorUrl=process.env.DOCLING_URL,priorFetch=globalThis.fetch;
 process.env.DOCLING_URL='http://docling.resume-test';
 await migrateKernel();
 const pdf=await PDFDocument.create();pdf.addPage();
 const owner=`resume-${randomUUID()}`,id=await saveDocument(owner,'','upload','resume','resume.pdf','application/pdf',await pdf.save());
 const job=await queueIngestionJob('docling_document','upload','test',{owner,id},randomUUID()),token=randomUUID();
 await kernelPool().query("UPDATE ingestion_jobs SET state='running',lease_token=$2 WHERE id=$1",[job,token]);
 try{
  await assert.rejects(rememberDoclingTask(job,'stale-token','remote-task'),/lease lost/);
  await rememberDoclingTask(job,token,'remote-task');
  const saved=(await kernelPool().query('SELECT payload FROM ingestion_jobs WHERE id=$1',[job])).rows[0].payload;
  assert.equal(saved.doclingTaskId,'remote-task');
  let submissions=0;
  globalThis.fetch=async input=>{
   const url=String(input);
   if(url.includes('/convert/')){submissions++;throw new Error('Should resume instead');}
   if(url.includes('/status/'))return Response.json({task_status:'success'});
   return Response.json({status:'success',document:{json_content:{pages:{1:{page_no:1}},
    body:{children:[{$ref:'#/texts/0'}]},texts:[{text:'Durably resumed PDF text',prov:[{page_no:1}]}]}}});
  };
  await convertDocumentWithDocling(owner,id,{id:job,leaseToken:token,taskId:saved.doclingTaskId});
  assert.equal(submissions,0);
  const {kernel}=await import('../lib/kernel/service.ts');
  assert.match((await kernel.parsedDocument(owner,id))[0].body,/Durably resumed/);
 }finally{
  globalThis.fetch=priorFetch;
  if(priorUrl===undefined)delete process.env.DOCLING_URL;else process.env.DOCLING_URL=priorUrl;
  await kernelPool().query('DELETE FROM ingestion_jobs WHERE id=$1',[job]);
 }
});

test('Docling reparse follows persistent job lifecycle, retries once and enforces ownership',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const before=process.env.DOCLING_URL;
 process.env.DOCLING_URL='http://docling.unused';
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument,getDocument}=await import('../lib/library.ts');
 const {getPdfFormulaReparseStatus,queuePdfFormulaReparse}=await import('../lib/pdf-formula-reparse.ts');
 const {DOCLING_PARSER_VERSION}=await import('../lib/kernel/docling-result.ts');
 const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
 await migrateKernel();
 const pdf=await PDFDocument.create();pdf.addPage();
 const id=await saveDocument('status-owner','math','upload','status.pdf','status.pdf','application/pdf',await pdf.save());
 const document=await getDocument('status-owner',id);
 const key=`docling:${id}:${document.hash}:${DOCLING_PARSER_VERSION}`;
 try{
  await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-page-v3-latex', 0, ?)").bind(id,'Prior text and formula').run();
  await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
  await db.prepare("INSERT INTO background_jobs(id,kind,payload,status,available_at,updated_at) VALUES (?,'index',?,'complete',0,0)")
   .bind(`index:${id}`,JSON.stringify({owner:'status-owner',id,forcePdfFormulaReparse:true})).run();
  await assert.rejects(getPdfFormulaReparseStatus('other-owner',id));
  assert.equal((await getPdfFormulaReparseStatus('status-owner',id)).status,'idle');
  assert.equal((await queuePdfFormulaReparse('status-owner',id)).status,'queued');
  assert.equal((await queuePdfFormulaReparse('status-owner',id)).status,'queued');
  assert.equal((await kernelPool().query('SELECT count(*) count FROM ingestion_jobs WHERE idempotency_key=$1',[key])).rows[0].count,'1');
  await kernelPool().query("UPDATE ingestion_jobs SET state='running' WHERE idempotency_key=$1",[key]);
  assert.equal((await getPdfFormulaReparseStatus('status-owner',id)).status,'running');
  await kernelPool().query("UPDATE ingestion_jobs SET state='failed',attempts=5,last_error='Synthetic failure' WHERE idempotency_key=$1",[key]);
  assert.equal((await getPdfFormulaReparseStatus('status-owner',id)).status,'failed');
  assert.equal((await queuePdfFormulaReparse('status-owner',id)).status,'queued');
  assert.equal((await kernelPool().query('SELECT attempts FROM ingestion_jobs WHERE idempotency_key=$1',[key])).rows[0].attempts,0);
  await kernelPool().query("UPDATE ingestion_jobs SET state='complete' WHERE idempotency_key=$1",[key]);
  assert.equal((await getPdfFormulaReparseStatus('status-owner',id)).status,'failed');
  await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,0,?)').bind(id,DOCLING_PARSER_VERSION,'New full transcription').run();
  assert.equal((await getPdfFormulaReparseStatus('status-owner',id)).status,'failed');
  const {kernel}=await import('../lib/kernel/service.ts');
  await kernel.ingestParsedDocument({id,ownerId:'status-owner',courseId:'',name:document.name,hash:document.hash,mime:document.mime,origin:document.origin,originKey:document.origin_key},
   [{locator:'第 1 页',text:'New full transcription'}],{parserVersion:DOCLING_PARSER_VERSION});
  assert.equal((await getPdfFormulaReparseStatus('status-owner',id)).status,'complete');
 }finally{
  await kernelPool().query('DELETE FROM ingestion_jobs WHERE idempotency_key=$1',[key]);
  if(before===undefined)delete process.env.DOCLING_URL;else process.env.DOCLING_URL=before;
 }
});
