import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {digest,saveBlob} from '../lib/library.ts';
import {createDoclingProgress} from '../lib/kernel/docling-batches.ts';
import {decodeCachedDoclingReplay,auditCachedDoclingReplay,applyCachedDoclingReplay} from '../lib/kernel/docling-cache-replay.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {kernel} from '../lib/kernel/service.ts';
import {nativeWhitespaceFingerprint} from '../lib/kernel/native-whitespace.ts';
import {readBlob} from '../lib/library.ts';

after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
async function fixture(sourceText='A source lesson with an equation',rawText=sourceText,formula=true){
 const pdf=await PDFDocument.create();
 if(formula)pdf.addPage().drawText(sourceText);else pdf.addPage([900,300]).drawText(sourceText,{x:25,y:200,size:10});
 pdf.addPage();
 const original=await pdf.save(),owner=`replay-owner-${randomUUID()}`,id=`replay-document-${randomUUID()}`;
 const identity={owner,documentId:id,sourceHash:digest(original),optionsHash:'b'.repeat(64),totalPages:2};
 const progress=createDoclingProgress(identity),blobs=new Map<string,Uint8Array>();
 for(const batch of progress.batches){
  const copyIndices=[batch.start-1],derived=await PDFDocument.create();
  derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));derived.setProducer('Study Kernel Docling derived-v1');derived.setCreator('Study Kernel');
  for(const p of await derived.copyPages(pdf,copyIndices))derived.addPage(p);
  batch.inputHash=digest(await derived.save());batch.copyIndices=copyIndices;
  if(batch.start===2)continue; // Verified original blank is represented without a fabricated result.
  const result={status:'success',document:{json_content:{pages:{1:{page_no:1}},body:{children:[{$ref:'#/texts/0'},...(formula?[{$ref:'#/texts/1'}]:[])]},
   texts:[{label:'text',text:rawText,orig:rawText,prov:[{page_no:1}]},
    ...(formula?[{label:'formula',text:'',orig:'q = original_symbol',prov:[{page_no:1}]}]:[])]}}};
  const bytes=Buffer.from(JSON.stringify({identity:{...identity,start:batch.start,end:batch.end,inputHash:batch.inputHash,copyIndices},result}));
  batch.resultHash=digest(bytes);blobs.set(batch.resultHash,bytes);
 }
 return {original,identity,progress,blobs};
}

test('cached replay restores raw formula, maps real pages and accepts only verified original blanks',async()=>{
 const f=await fixture(),load=async(hash:string)=>f.blobs.get(hash)!;
 const decoded=await decodeCachedDoclingReplay(f.original,f.identity,f.progress,load);
 assert.deepEqual(decoded.pages.map(p=>p.pageNumber),[1,2]);assert.equal(decoded.pages[1].text,'');
 assert.match(decoded.pages[0].text,/q = original_symbol/);assert.match(decoded.warnings.join(' '),/未验证 LaTeX/);
 const missing=structuredClone(f.progress);delete missing.batches[0].resultHash;
 await assert.rejects(decodeCachedDoclingReplay(f.original,f.identity,missing,load),/missing a nonblank/);
});

let poppler=false;try{execFileSync('pdftotext',['-v'],{stdio:'ignore'});poppler=true;}catch{/* CI explicitly requires the native dependency. */}
test('cached native whitespace audit is readonly; reviewed publication retains history and rejects raw downgrade',
 {skip:!process.env.KERNEL_DATABASE_URL||(!poppler&&process.env.CI!=='true')},async()=>{
 assert.ok(poppler,'CI requires Poppler for cached native-whitespace publication');
 await migrateKernel();
 const text='This original PDF paragraph compares separate models with independent evidence. The named model is Copper Baseline in the original source.',
 fused=text.replace('is Copper','isCopper'),f=await fixture(text,fused,false),pool=kernelPool();
 await saveBlob(f.original);for(const bytes of f.blobs.values())await saveBlob(bytes);
 const doc={id:f.identity.documentId,ownerId:f.identity.owner,courseId:'',name:'Cached source.pdf',hash:f.identity.sourceHash,mime:'application/pdf',origin:'upload',originKey:randomUUID()};
 await kernel.ingestParsedDocument(doc,[{pageNumber:1,locator:'第 1 页',text:fused},{pageNumber:2,locator:'第 2 页',text:''}],
  {parserVersion:'docling-v3-raw-whitespace-fixture',extractionMethod:'docling-text',batchProvenance:f.progress});
 const prior={mode:process.env.DOCLING_NATIVE_WHITESPACE,local:process.env.LOCAL_OCR,fetch:globalThis.fetch};
 const manifest=async()=>{const root=resolve(process.env.LIBRARY_DIR||'./data/library'),names=(await readdir(root)).filter(n=>/^[a-f0-9]{64}$/.test(n)).sort();
  return Promise.all(names.map(async name=>({name,mtimeMs:(await stat(resolve(root,name))).mtimeMs,sha256:digest(await readBlob(name))})));};
 const versionCount=async()=>Number((await pool.query('SELECT count(*) n FROM document_text_versions WHERE document_id=$1',[doc.id])).rows[0].n);
 globalThis.fetch=async()=>{throw Error('Cached derivation forbids external parsing or model requests');};
 try{
  process.env.DOCLING_NATIVE_WHITESPACE='source-v1';process.env.LOCAL_OCR='true';
  const before=await manifest(),audited=await auditCachedDoclingReplay(doc.ownerId,doc.id);
  assert.equal(audited.decision,'eligible');assert.deepEqual(audited.changedPages,[1]);assert.equal(audited.pages[0].text,text);
  assert.deepEqual(await manifest(),before,'audit must not create or touch CAS receipts');assert.equal(await versionCount(),1);
  assert.equal(JSON.stringify(audited).includes('rawOutputSha256'),false,'serialized audit stores the receipt hash, not another full native output');
  const metadata=nativeWhitespaceFingerprint(audited.batchProvenance)!;assert.ok(typeof metadata.receiptHash==='string');
  assert.equal(audited.batchProvenance.identity.optionsHash,f.identity.optionsHash,'old conversion options are unchanged');
  process.env.DOCLING_NATIVE_WHITESPACE='off';await assert.rejects(applyCachedDoclingReplay(audited,audited.expectedCurrentVersion),/changed after audit/);
  assert.deepEqual(await manifest(),before);assert.equal(await versionCount(),1);
  process.env.DOCLING_NATIVE_WHITESPACE='source-v1';process.env.LOCAL_OCR='false';
  await assert.rejects(applyCachedDoclingReplay(audited,audited.expectedCurrentVersion),/changed after audit/);
  assert.deepEqual(await manifest(),before);assert.equal(await versionCount(),1);
  process.env.LOCAL_OCR='true';
  const applied=await applyCachedDoclingReplay(audited,audited.expectedCurrentVersion);
  assert.equal(applied.action,'published');assert.equal(await versionCount(),2);
  assert.equal((await kernel.parsedDocument(doc.ownerId,doc.id))[0].body,text);
  assert.equal((await pool.query('SELECT body FROM document_text_pages WHERE version_id=$1 AND page_number=1',[audited.expectedCurrentVersion])).rows[0].body,fused);
  const proof=JSON.parse((await readBlob(metadata.receiptHash)).toString());assert.equal(proof.sourceHash,doc.hash);
  assert.equal(proof.pages[0].originalBodySha256,digest(fused));assert.equal(proof.pages[0].projectedBodySha256,digest(text));
  assert.equal(proof.structureRelationsVerified,false);
  const current=(await pool.query('SELECT v.source_version_id,s.raw_value FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id JOIN source_item_versions s ON s.id=v.source_version_id WHERE d.id=$1',[doc.id])).rows[0];
  const {parsingProvenanceBlobHashes}=await import('../lib/kernel/docling-batches.ts'),refs=await parsingProvenanceBlobHashes(current.raw_value.batchProvenance,
   {owner:doc.ownerId,documentId:doc.id,sourceHash:doc.hash,totalPages:2});
  assert.ok(refs.includes(metadata.receiptHash));for(const rawHash of f.blobs.keys())assert.ok(refs.includes(rawHash));
  const beforeRepeat=await manifest(),repeated=await auditCachedDoclingReplay(doc.ownerId,doc.id);
  assert.deepEqual(await manifest(),beforeRepeat);assert.deepEqual(repeated.changedPages,[]);
  assert.deepEqual(nativeWhitespaceFingerprint(repeated.batchProvenance),metadata);
  assert.equal((await applyCachedDoclingReplay(repeated,repeated.expectedCurrentVersion)).action,'unchanged');assert.equal(await versionCount(),2);
  process.env.DOCLING_NATIVE_WHITESPACE='off';await assert.rejects(auditCachedDoclingReplay(doc.ownerId,doc.id),/cannot downgrade/);
  process.env.DOCLING_NATIVE_WHITESPACE='source-v1';process.env.LOCAL_OCR='false';
  await assert.rejects(auditCachedDoclingReplay(doc.ownerId,doc.id),/observation unavailable/);
  assert.equal((await kernel.parsedDocument(doc.ownerId,doc.id))[0].body,text);assert.equal(await versionCount(),2);
  assert.equal(digest(await readBlob(doc.hash)),doc.hash);
 }finally{globalThis.fetch=prior.fetch;for(const [key,value]of [['DOCLING_NATIVE_WHITESPACE',prior.mode],['LOCAL_OCR',prior.local]]){
  if(value===undefined)delete process.env[key!];else process.env[key!]=value;
 }}
});

test('cached replay refuses corrupt result bytes and changed source/options/mapping instead of reparsing',async()=>{
 const f=await fixture(),load=async(hash:string)=>f.blobs.get(hash)!;
 await assert.rejects(decodeCachedDoclingReplay(f.original,{...f.identity,sourceHash:'0'.repeat(64)},f.progress,load),/original or options/);
 await assert.rejects(decodeCachedDoclingReplay(f.original,f.identity,f.progress,async()=>Buffer.from('corrupt')),/checksum/);
 const changed=structuredClone(f.progress);changed.batches[0].copyIndices=[1];
 await assert.rejects(decodeCachedDoclingReplay(f.original,f.identity,changed,load),/identity or range/);
 const raw=JSON.parse(Buffer.from(f.blobs.get(f.progress.batches[0].resultHash!)!).toString());raw.identity.optionsHash='c'.repeat(64);
 const bytes=Buffer.from(JSON.stringify(raw)),updated=structuredClone(f.progress);updated.batches[0].resultHash=digest(bytes);
 await assert.rejects(decodeCachedDoclingReplay(f.original,f.identity,updated,async()=>bytes),/source, options or range/);
});

test('reviewed cache publication retains evidence history, rejects stale CAS and replays unchanged without a new version',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const f=await fixture(),pool=kernelPool();
 assert.equal(await saveBlob(f.original),f.identity.sourceHash);
 for(const bytes of f.blobs.values())await saveBlob(bytes);
 const doc={id:f.identity.documentId,ownerId:f.identity.owner,courseId:'',name:'Source.pdf',hash:f.identity.sourceHash,mime:'application/pdf',origin:'upload',originKey:randomUUID()};
 const oldPages=[{pageNumber:1,locator:'第 1 页',text:'A source lesson with an equation'},{pageNumber:2,locator:'第 2 页',text:''}];
 await kernel.ingestParsedDocument(doc,oldPages,{parserVersion:'docling-v2-text-search',extractionMethod:'docling-text',
  warnings:['Existing caution'],batchProvenance:f.progress});
 const reviewed=await auditCachedDoclingReplay(f.identity.owner,f.identity.documentId);
 assert.equal(reviewed.decision,'eligible');assert.deepEqual(reviewed.changedPages,[1]);
 const published=await applyCachedDoclingReplay(reviewed,reviewed.expectedCurrentVersion,async()=>null);
 assert.equal(published.action,'published');assert.notEqual(published.currentVersion,reviewed.expectedCurrentVersion);
 const pages=await kernel.parsedDocument(f.identity.owner,f.identity.documentId);
 assert.match(pages[0].body,/q = original_symbol/);assert.equal(pages[1].body,'');assert.ok(pages[0].warnings.includes('Existing caution'));
 const evidence=(await pool.query(`SELECT p.page_number,e.parsed_value,s.raw_uri,s.raw_sha256 FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id
  JOIN evidence e ON e.id=p.evidence_id JOIN source_item_versions s ON s.id=v.source_version_id WHERE d.id=$1 ORDER BY p.page_number`,[doc.id])).rows;
 assert.equal(evidence[0].parsed_value.pageProvenance.basedOn.versionId,reviewed.expectedCurrentVersion);
 assert.equal(evidence[0].parsed_value.extractionMethod,'cached-docling-redecode');
 assert.equal(evidence[1].parsed_value.extractionMethod,'docling-text');assert.equal(evidence[0].raw_sha256,doc.hash);
 assert.equal(evidence[0].raw_uri,`library://${doc.hash}`);
 await assert.rejects(applyCachedDoclingReplay(reviewed,reviewed.expectedCurrentVersion),/changed after audit/);
 const repeated=await auditCachedDoclingReplay(f.identity.owner,f.identity.documentId);
 // A missing renderer remains eligible for visual recovery, while another
 // unavailable attempt with identical staged content must not publish a version.
 assert.equal(repeated.decision,'eligible');assert.deepEqual(repeated.changedPages,[]);
 assert.equal(repeated.visualOnly,true);assert.equal(repeated.visualEvidence.status,'render-incomplete');
 assert.equal((await applyCachedDoclingReplay(repeated,published.currentVersion,async()=>null)).action,'unchanged');
 assert.equal(Number((await pool.query('SELECT count(*) n FROM document_text_versions WHERE document_id=$1',[doc.id])).rows[0].n),2);
 const invalid=await auditCachedDoclingReplay(f.identity.owner,f.identity.documentId);
 await kernel.ingestParsedDocument(doc,oldPages,{parserVersion:'fresh-normal-parse',extractionMethod:'docling-text',batchProvenance:f.progress});
 await assert.rejects(applyCachedDoclingReplay(invalid,invalid.expectedCurrentVersion),/changed after audit/);
 assert.equal((await kernel.parsedDocument(f.identity.owner,f.identity.documentId))[0].parser_version,'fresh-normal-parse');
});
