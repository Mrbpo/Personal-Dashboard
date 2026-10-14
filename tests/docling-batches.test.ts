import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PDFDocument,PDFArray,PDFStream} from 'pdf-lib';

const directory=mkdtempSync(join(tmpdir(),'docling-batch-tests-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=directory;
process.env.DOCLING_URL='http://docling.mock';
process.env.DOCLING_NATIVE_TEXT_FASTPATH='false';
process.env.DOCLING_FORMULA_ENRICHMENT='false';
process.env.PDF_SCAN_TRANSCRIPTION_BACKEND='docling';
delete process.env.DOCLING_BATCH_PAGES;
after(()=>rmSync(directory,{recursive:true,force:true}));

async function fakePrepare(start:number,end:number){
 const form=new FormData();form.append('test_original_start',String(start));
 form.append('page_range','1');form.append('page_range',String(end-start+1));
 return {form,inputHash:start.toString(16).repeat(64),copyIndices:Array.from({length:end-start+1},(_,i)=>start+i-1)};
}

function result(start:number,end=start){
 return {status:'success',document:{json_content:{
  pages:Object.fromEntries(Array.from({length:end-start+1},(_,i)=>[start+i,{page_no:start+i}])),
  body:{children:Array.from({length:end-start+1},(_,i)=>({$ref:`#/texts/${i}`}))},
  texts:Array.from({length:end-start+1},(_,i)=>({text:`Verified original page ${start+i}`,prov:[{page_no:start+i}]})),
 }}};
}
function pageContents(pdf:PDFDocument,index:number){
 const value=pdf.getPage(index).node.Contents();
 const streams=value instanceof PDFArray?value.asArray().map(ref=>pdf.context.lookup(ref)):[value];
 return Buffer.concat(streams.map(stream=>{assert.ok(stream instanceof PDFStream);return Buffer.from(stream.getContents());}));
}
const identity={owner:'owner',documentId:'original',sourceHash:'a'.repeat(64),optionsHash:'b'.repeat(64),totalPages:3};

test('default is a single page; original range IDs are exact and full-document validation stays strict',async()=>{
 const {createDoclingProgress,validateDoclingProgress}=await import('../lib/kernel/docling-batches.ts');
 const {decodeDerivedDoclingResult}=await import('../lib/kernel/docling-batches.ts');
 const {decodeDoclingResult}=await import('../lib/kernel/docling-result.ts');
 assert.deepEqual(createDoclingProgress(identity).batches,[{start:1,end:1},{start:2,end:2},{start:3,end:3}]);
 assert.throws(()=>createDoclingProgress(identity,5),/integer from 1 to 4/);
 assert.equal(createDoclingProgress({...identity,totalPages:7},4).batches[1].end,7);
 assert.deepEqual(decodeDoclingResult(result(5,8),10,{pageRange:[5,8]}).pages.map(p=>p.pageNumber),[5,6,7,8]);
 assert.throws(()=>decodeDoclingResult(result(1,4),10,{pageRange:[5,8]}),/manifest/);
 assert.throws(()=>decodeDoclingResult(result(5,7),10,{pageRange:[5,8]}),/manifest/);
 assert.throws(()=>decodeDoclingResult(result(5,8),10),/manifest/);
 const bad=result(5);bad.document.json_content.texts[0].prov=[{page_no:6}];
 assert.throws(()=>decodeDoclingResult(bad,10,{pageRange:[5,5]}),/provenance/);
 const mapping={start:5,end:5,totalPages:10,copyIndices:[4]},options={formulaEnriched:false,verifiedBlankPages:[]};
 assert.equal(decodeDerivedDoclingResult(result(1),mapping,options).pages[0].pageNumber,5);
 assert.throws(()=>decodeDerivedDoclingResult(result(5),mapping,options),/manifest/);
 assert.throws(()=>decodeDerivedDoclingResult(result(1),{...mapping,copyIndices:[0]},options),/mapping/);
 for(const changed of [{owner:'other'}, {sourceHash:'c'.repeat(64)}, {optionsHash:'d'.repeat(64)}])
  assert.throws(()=>validateDoclingProgress(createDoclingProgress(identity),{...identity,...changed}),/identity/);
});

test('validated batch blobs survive a later failure; retries reuse them and corrupt blobs reparse only their range',async()=>{
 const {convertDoclingBatches}=await import('../lib/kernel/docling-batches.ts');
 const original=globalThis.fetch;let progress:unknown,fail=true;const submitted:number[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/async')){
   const range=(init?.body as FormData).getAll('page_range').map(Number);
   assert.deepEqual(range,[1,1]);const original=Number((init?.body as FormData).get('test_original_start'));submitted.push(original);
   if(original===2&&fail)return new Response(null,{status:503});
   return Response.json({task_id:`page-${original}`,task_status:'success'});
  }
  return Response.json(result(1));
 };
 const run=()=>convertDoclingBatches({identity,progress,verifiedBlankPages:[],formulaEnriched:false,
  endpoint:'http://docling.mock',headers:{},prepare:fakePrepare,persist:async value=>{progress=structuredClone(value);}});
 try{
  await assert.rejects(run(),/submit failed/);
  const saved=progress as {batches:{resultHash?:string}[]};
  assert.match(saved.batches[0].resultHash!,/^[a-f0-9]{64}$/);assert.equal(saved.batches[1].resultHash,undefined);
  fail=false;
  assert.deepEqual((await run()).pages.map(p=>p.pageNumber),[1,2,3]);
  assert.deepEqual(submitted,[1,2,2,3]);
  await run();assert.equal(submitted.length,4);
  const current=progress as typeof saved;
  writeFileSync(join(directory,current.batches[1].resultHash!),'corrupt');
  await run();assert.deepEqual(submitted,[1,2,2,3,2]);
  assert.notEqual(readFileSync(join(directory,(progress as typeof saved).batches[1].resultHash!)).toString(),'corrupt');
  (progress as {batches:{inputHash:string}[]}).batches[2].inputHash='e'.repeat(64);
  await assert.rejects(run(),/input identity mismatch/);assert.equal(submitted.length,5);
 }finally{globalThis.fetch=original;}
});

for(const lostAt of ['poll','result'] as const){
 test(`remote restart missing ${lostAt} task resumes one verified derived batch without replaying completed pages`,async()=>{
  const {createDoclingProgress,convertDoclingBatches,requestDoclingResult}=await import('../lib/kernel/docling-batches.ts');
  const scope={...identity,documentId:`restart-${lostAt}-${randomUUID()}`};
  const saved=createDoclingProgress(scope);
  for(const batch of saved.batches){
   const prepared=await fakePrepare(batch.start,batch.end);
   batch.inputHash=prepared.inputHash;batch.copyIndices=prepared.copyIndices;
   if(batch.start===3){batch.taskId='lost-before-restart';continue;}
   const bytes=Buffer.from(JSON.stringify({identity:{...scope,start:batch.start,end:batch.end,
    inputHash:prepared.inputHash,copyIndices:prepared.copyIndices},result:result(1)}));
   batch.resultHash=createHash('sha256').update(bytes).digest('hex');
   writeFileSync(join(directory,batch.resultHash),bytes);
  }
  const completed=saved.batches.slice(0,2).map(batch=>({hash:batch.resultHash!,
   bytes:readFileSync(join(directory,batch.resultHash!))}));
  let progress=structuredClone(saved),preparedForm:FormData|undefined,replacementMissing=false;
  const snapshots:typeof saved[]=[],submissions:number[]=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
   const url=String(input);
   if(url.endsWith('/async')){
    assert.equal(init?.body,preparedForm,'reuse the same form that passed derived input verification');
    const form=init?.body as FormData;
    assert.deepEqual(form.getAll('page_range'),['1','1']);
    submissions.push(Number(form.get('test_original_start')));
    return Response.json({task_id:'new-after-restart',task_status:'success'});
   }
   if(url.endsWith('/status/poll/lost-before-restart'))
    return lostAt==='poll'?new Response(null,{status:404}):Response.json({task_status:'success'});
   if(url.endsWith('/result/lost-before-restart'))return new Response(null,{status:404});
   assert.equal(url,'http://docling.mock/v1/result/new-after-restart','only the resumed range may reach Docling');
   return replacementMissing?new Response(null,{status:404}):Response.json(result(1));
  };
  const run=()=>convertDoclingBatches({identity:scope,progress,verifiedBlankPages:[],formulaEnriched:false,
   endpoint:'http://docling.mock',headers:{},prepare:async(start,end)=>{
    const prepared=await fakePrepare(start,end);if(start===3)preparedForm=prepared.form;return prepared;
   },persist:async value=>{progress=structuredClone(value);snapshots.push(structuredClone(value));}});
  try{
   const parsed=await run();
   assert.deepEqual(parsed.pages.map(page=>page.pageNumber),[1,2,3]);
   assert.deepEqual(submissions,[3],'completed verified batches must never be submitted again');
   assert.ok(snapshots.some(value=>!value.batches[2].taskId&&!value.batches[2].resultHash),'clear the lost ID before submitting');
   assert.ok(snapshots.some(value=>value.batches[2].taskId==='new-after-restart'));
   assert.ok(progress.batches[2].resultHash);
   for(const [index,batch] of completed.entries()){
    assert.equal(progress.batches[index].resultHash,batch.hash);
    assert.deepEqual(readFileSync(join(directory,batch.hash)),batch.bytes);
   }
   // The replacement can also disappear (for example after OOM). Stop after
   // that one submission; never recursively resubmit a newly created task.
   progress=structuredClone(saved);replacementMissing=true;
   await assert.rejects(run(),/Docling result failed \(404\)/);
   assert.deepEqual(submissions,[3,3]);
   assert.equal(progress.batches[2].taskId,undefined);
   assert.equal(progress.batches[2].resultHash,undefined);
   assert.deepEqual(progress.batches.slice(0,2).map(batch=>batch.resultHash),completed.map(batch=>batch.hash));
   const cleared:(string|null)[]=[];
   await assert.rejects(requestDoclingResult('http://docling.mock',{},undefined,'lost-before-restart',
    async task=>{cleared.push(task);}),new RegExp(`Docling ${lostAt} failed \\(404\\)`));
   assert.deepEqual(cleared,[null],'legacy task IDs without derived form only clear and fail');
   assert.deepEqual(submissions,[3,3],'legacy recovery must not submit an entire document');
  }finally{globalThis.fetch=originalFetch;}
 });
}

test('incomplete batch results never cache and only original-verified blanks bypass requests',async()=>{
 const {convertDoclingBatches}=await import('../lib/kernel/docling-batches.ts');
 const original=globalThis.fetch;let progress:unknown,calls=0;
 const run=(verifiedBlankPages:number[]=[])=>convertDoclingBatches({identity,progress,verifiedBlankPages,formulaEnriched:false,
  endpoint:'http://docling.mock',headers:{},prepare:fakePrepare,persist:async value=>{progress=structuredClone(value);}});
 globalThis.fetch=async input=>{
  calls++;
  return String(input).endsWith('/async')?Response.json({task_id:'invalid',task_status:'success'}):
   Response.json({...result(1),status:'partial_success'});
 };
 try{
  await assert.rejects(run(),/incomplete/);
  assert.equal((progress as {batches:{resultHash?:string;taskId?:string}[]}).batches[0].resultHash,undefined);
  assert.equal((progress as {batches:{taskId?:string}[]}).batches[0].taskId,undefined);
  progress=undefined;calls=0;
  await assert.rejects(run([1,2,3]),/incomplete/);
  assert.equal(calls,0,'original-verified blank batches need no model, but wholly blank documents cannot publish');
 }finally{globalThis.fetch=original;}
});

test('converter publishes only once after every original page passes, preserving an older readable cache on failure',async t=>{
 const {saveDocument,getDocument}=await import('../lib/library.ts');
 const {database:db}=await import('../lib/database.ts');
 const {kernel}=await import('../lib/kernel/service.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
 const pdf=await PDFDocument.create();for(let i=0;i<5;i++)pdf.addPage().drawText(`Original visible page ${i+1}`);
 const sourceBytes=await pdf.save(),source=await PDFDocument.load(sourceBytes,{updateMetadata:false});
 const id=await saveDocument('converter-owner','','upload','batch','batch.pdf','application/pdf',sourceBytes);
 await db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(id+':old',id,0,'第 1 页','Prior complete text','old').run();
 await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
 const publish=t.mock.method(kernel,'ingestParsedDocument',async(...args:Parameters<typeof kernel.ingestParsedDocument>)=>{void args;});
 const previous=globalThis.fetch;let fail=true,requestNumber=0;
 const copiedHashes=new Map<number,string>();
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/async')){
   const range=(init?.body as FormData).getAll('page_range').map(Number);
   assert.deepEqual(range,[1,1]);
   const original=(init?.body as FormData).get('files') as Blob;
   const inputBytes=await original.arrayBuffer(),derived=await PDFDocument.load(inputBytes);
   assert.equal(derived.getPageCount(),1,'request contains only the explicitly copied page');
   assert.equal(derived.getCreationDate()?.getTime(),0,'retry bytes have stable metadata');
   const position=++requestNumber;
   const hash=createHash('sha256').update(Buffer.from(inputBytes)).digest('hex');
   if(copiedHashes.has(position))assert.equal(hash,copiedHashes.get(position),'reconstructing the same original page yields the same input SHA');
   copiedHashes.set(position,hash);
   assert.deepEqual(pageContents(derived,0),pageContents(source,position-1),'copy uses the intended original page, including page 5');
   if(fail&&position===2)return new Response(null,{status:503});
   return Response.json({task_id:`page-${position}`,task_status:'success'});
  }
  return Response.json(result(1));
 };
 try{
  await assert.rejects(convertDocumentWithDocling('converter-owner',id),/submit failed/);
  assert.equal(publish.mock.callCount(),0);
  assert.equal((await getDocument('converter-owner',id)).status,'ready');
  assert.equal((await db.prepare('SELECT body FROM library_chunks WHERE document_id=?').bind(id).first<{body:string}>())?.body,'Prior complete text');
  fail=false;requestNumber=0;await convertDocumentWithDocling('converter-owner',id);
  assert.equal(publish.mock.callCount(),1);
  assert.deepEqual(publish.mock.calls[0].arguments[1].map(p=>p.pageNumber),[1,2,3,4,5]);
 }finally{globalThis.fetch=previous;publish.mock.restore();}
});

test('PG job stages, exact claims, remote resume, lease-guarded publication, revive and blob GC',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');await migrateKernel();
 const {queueIngestionJob,claimIngestionJob,finishIngestionJob,doclingJobPayload,rememberDoclingProgress,rememberDoclingTask}=await import('../lib/kernel/jobs.ts');
 const {saveDocument,getDocument,collectUnusedBlobs}=await import('../lib/library.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
 const {kernel}=await import('../lib/kernel/service.ts');
 const pdf=await PDFDocument.create();for(let i=0;i<2;i++)pdf.addPage().drawText('Original body '+i);
 const owner=randomUUID(),id=await saveDocument(owner,'','upload',owner,owner+'.pdf','application/pdf',await pdf.save());
 const doc=await getDocument(owner,id),payload={owner,id,sourceHash:doc.hash,formulaEnriched:false,formulaBackend:'ai',scanBackend:'docling'};
 const key=randomUUID(),jobId=await queueIngestionJob('docling_document','upload','test',payload,key);
 const first=await claimIngestionJob(jobId);assert.equal(first?.id,jobId);
 const previous=globalThis.fetch;const submits:number[]=[];let fail=true;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/async')){
   assert.deepEqual((init?.body as FormData).getAll('page_range'),['1','1']);
   const page=submits.length+1;submits.push(page);
   return Response.json({task_id:`page-${page}`,task_status:'success'});
  }
  if(url.includes('/status/'))return Response.json({task_status:'success'});
  const page=Number(url.split('-').at(-1));
  if(fail&&page===2)return new Response(null,{status:503});
  return Response.json(result(1));
 };
 try{
  const context=(job:NonNullable<typeof first>)=>({id:job.id,leaseToken:job.lease_token,formulaEnriched:false});
  await assert.rejects(convertDocumentWithDocling(owner,id,context(first!)),/result failed/);
  const staged=await doclingJobPayload(jobId,first!.lease_token);
  assert.equal((staged.doclingProgress as {batches:{taskId?:string}[]}).batches[1].taskId,'page-2');
  assert.equal((await kernel.parsedDocument(owner,id)).length,0,'partial batches are not canonical');
  const hash=(staged.doclingProgress as {batches:{resultHash:string}[]}).batches[0].resultHash;
  await collectUnusedBlobs(Date.now()+2*86400000);assert.ok(readFileSync(join(directory,hash)).length);
  await finishIngestionJob(jobId,first!.lease_token,'synthetic restart');
  await kernelPool().query('UPDATE ingestion_jobs SET available_at=now() WHERE id=$1',[jobId]);
  const next=await claimIngestionJob(jobId);assert.ok(next);
  await assert.rejects(rememberDoclingProgress(jobId,first!.lease_token,staged.doclingProgress as never),/lease/);
  await assert.rejects(rememberDoclingTask(jobId,first!.lease_token,'foreign-task'),/lease/);
  await assert.rejects(kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',hash:doc.hash,name:doc.name,mime:doc.mime,origin:doc.origin,originKey:doc.origin_key},
   [{locator:'第 1 页',text:'Stale writer'}],{ingestionLease:{id:jobId,token:first!.lease_token}}),/lease/);
  fail=false;await convertDocumentWithDocling(owner,id,context(next!));
  assert.deepEqual(submits,[1,2],'resumed remote page must not be submitted again');
  const pages=await kernel.parsedDocument(owner,id);assert.deepEqual(pages.map(p=>p.page_number),[1,2]);
  await finishIngestionJob(jobId,next!.lease_token);
  await queueIngestionJob('docling_document','upload','test',payload,key,true);
  const revived=await claimIngestionJob(jobId);assert.ok(revived);
  await convertDocumentWithDocling(owner,id,context(revived!));assert.deepEqual(submits,[1,2]);
  await finishIngestionJob(jobId,revived!.lease_token);
  await queueIngestionJob('docling_document','upload','test',{...payload,sourceHash:'f'.repeat(64)},key,true);
  const changed=await claimIngestionJob(jobId);assert.ok(changed);
  await assert.rejects(convertDocumentWithDocling(owner,id,context(changed!)),/identity mismatch/);
  assert.deepEqual(submits,[1,2]);
  assert.equal((await kernel.parsedDocument(owner,id))[0].body,pages[0].body);
 }finally{globalThis.fetch=previous;await kernelPool().query('DELETE FROM ingestion_jobs WHERE id=$1',[jobId]);}
});
