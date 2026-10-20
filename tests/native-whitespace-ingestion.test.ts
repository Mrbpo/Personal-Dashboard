import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
let poppler=false;try{execFileSync('pdftotext',['-v'],{stdio:'ignore'});poppler=true;}catch{/* Explicit skip when the native dependency is unavailable. */}
const directory=mkdtempSync(join(tmpdir(),'native-whitespace-ingestion-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;
after(async()=>{if(process.env.KERNEL_DATABASE_URL){const {kernelPool}=await import('../lib/kernel/db.ts');await kernelPool().end();}rmSync(directory,{recursive:true,force:true});});
test('real Poppler through normal Docling ingestion retains original/raw/history, search and proof GC roots',
 {skip:!process.env.KERNEL_DATABASE_URL||!poppler},async()=>{
 const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts'),{kernel}=await import('../lib/kernel/service.ts');
 const {saveDocument,getDocument,readBlob,saveBlob,digest}=await import('../lib/library.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
 const {parsingProvenanceBlobHashes}=await import('../lib/kernel/docling-batches.ts');
 await migrateKernel();
 const text='This original PDF paragraph compares separate models with independent evidence. The named model is Copper Baseline in the original source.';
 const fused=text.replace('is Copper','isCopper');
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([900,300]);
 page.drawText(text,{x:25,y:200,size:10,font});const bytes=await pdf.save(),hash=digest(bytes);
 const owner='native-whitespace-isolated-owner',id=await saveDocument(owner,'','upload','native-whitespace','Source.pdf','application/pdf',bytes);
 const priorFetch=globalThis.fetch,settings={DOCLING_URL:'http://scripted-docling.invalid',DOCLING_NATIVE_TEXT_FASTPATH:'false',
  DOCLING_FORMULA_ENRICHMENT:'false',PDF_SCAN_TRANSCRIPTION_BACKEND:'docling',LOCAL_OCR:'true',DOCLING_NATIVE_WHITESPACE:'off'};
 const before=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));Object.assign(process.env,settings);
 let calls=0;
 globalThis.fetch=async input=>{calls++;const url=String(input);
  if(url.endsWith('/async'))return Response.json({task_id:'synthetic-observation',task_status:'success'});
  if(!url.includes('/result/'))throw Error('Unexpected external request');
  return Response.json({status:'success',document:{json_content:{pages:{1:{page_no:1,size:{width:900,height:300}}},
   body:{children:[{$ref:'#/texts/0'}]},texts:[{label:'text',text:fused,orig:fused,prov:[{page_no:1}]}]}}});
 };
 const versions=()=>kernelPool().query(`SELECT v.id,v.parser_version,s.raw_value->'batchProvenance' progress
  FROM document_text_versions v JOIN source_item_versions s ON s.id=v.source_version_id WHERE v.document_id=$1 ORDER BY v.created_at,v.id`,[id]);
 try{
  await convertDocumentWithDocling(owner,id);const old=(await kernel.parsedDocument(owner,id))[0];assert.equal(old.body,fused);
  const oldVersion=(await versions()).rows[0].id;
  process.env.DOCLING_NATIVE_WHITESPACE='source-v1';await convertDocumentWithDocling(owner,id);
  const current=(await kernel.parsedDocument(owner,id))[0];assert.equal(current.body,text);
  assert.match(current.parser_version,/source-observed-whitespace-v1/);
  const rows=(await versions()).rows;assert.equal(rows.length,2);assert.ok(rows.some(r=>r.id===oldVersion));
  const progress=rows.find(r=>r.progress.nativeWhitespace)?.progress;assert.equal(progress.nativeWhitespace.changedBlocks,1);
  const proofHash=progress.nativeWhitespace.receiptHash,proof=JSON.parse((await readBlob(proofHash)).toString());
  assert.equal(proof.sourceHash,hash);assert.equal(proof.native.sourceHash,hash);assert.match(proof.native.engineVersion,/pdftotext version/);
  assert.equal(proof.pages[0].originalBodySha256,digest(fused));assert.equal(proof.pages[0].projectedBodySha256,digest(text));
  assert.equal(proof.structureRelationsVerified,false);assert.equal(proof.semanticAliasesVerified,false);
  const refs=await parsingProvenanceBlobHashes(progress,{owner,documentId:id,sourceHash:hash,totalPages:1});assert.ok(refs.includes(proofHash));
  const rawHash=progress.batches[0].resultHash;assert.ok(refs.includes(rawHash));assert.match((await readBlob(rawHash)).toString(),/isCopper/);
  const hits=await kernel.searchDocumentText(owner,'Copper Baseline',{documentId:id,limit:3});
  assert.ok(hits.some(h=>h.body.includes('is Copper Baseline')));
  await convertDocumentWithDocling(owner,id);assert.equal((await versions()).rows.length,2,'same observations replay without a third version');
  assert.equal(digest(await readBlob(hash)),hash);assert.equal((await getDocument(owner,id)).hash,hash);
  assert.equal(calls,6,'three synthetic Docling submit/result pairs; zero model requests');
  // Protocol control: two exact serializations of the same real observation
  // are distinct CAS artifacts. A same-body new artifact must not be swallowed
  // by source-version idempotency; neither artifact asserts a new model result.
  const alternateHash=await saveBlob(Buffer.from(JSON.stringify(proof,null,2)));
  assert.notEqual(alternateHash,proofHash);
  const identityId=await saveDocument(owner,'','upload','identity-control','Identity.pdf','application/pdf',bytes);
  const doc=await getDocument(owner,identityId),identity={id:doc.id,ownerId:owner,name:doc.name,hash:doc.hash,mime:doc.mime,courseId:'',origin:doc.origin,originKey:doc.origin_key};
  for(const receiptHash of [proofHash,alternateHash])await kernel.ingestParsedDocument(identity,[{pageNumber:1,locator:'page 1',text}],
   {parserVersion:'native-whitespace-identity-control',batchProvenance:{nativeWhitespace:{...progress.nativeWhitespace,receiptHash},
    blobReferences:[{kind:'native-whitespace-observation',sha256:receiptHash,byteLength:(await readBlob(receiptHash)).length}]}});
  assert.equal(Number((await kernelPool().query('SELECT count(*) n FROM document_text_versions WHERE document_id=$1',[identityId])).rows[0].n),2);
 }finally{globalThis.fetch=priorFetch;for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
