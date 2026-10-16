import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const directory=await mkdtemp(join(tmpdir(),'parsing-provenance-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;
const {saveBlob,readBlob,digest,collectUnusedBlobs}=await import('../lib/library.ts');
const {storeDoclingResult,createDoclingProgress,parsingProvenanceBlobHashes}=await import('../lib/kernel/docling-batches.ts');
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();await rm(directory,{recursive:true,force:true});});

async function fixture(){
 const binding={owner:randomUUID(),documentId:randomUUID(),sourceHash:await saveBlob(Buffer.from('original '+randomUUID())),totalPages:2};
 const dictionary={version:'exact-font-reference-v1',witnessSha256:digest('inline witness'),
  fonts:[{sha256:digest('embedded font, not a CAS blob'),unitsPerEm:1000}],
  mappings:[[0,1,[{kind:'cmap',codePoint:97}]]],entries:[[digest('outline, not a CAS blob'),'0061',[0]]]};
 const dictionaryHash=await storeDoclingResult(dictionary);
 const proof={version:'source-font-reference-v2',sourceHash:binding.sourceHash,inputHash:digest('derived input'),copyIndices:[0],
  referenceDictionarySha256:dictionaryHash,patches:[{font:1}],preserved:[{font:2}]};
 const receiptHash=await storeDoclingResult({kind:proof.version,proof});
 const resultHash=await storeDoclingResult({result:'saved parser result'});
 const progress=createDoclingProgress({...binding,optionsHash:digest('parser options'),sourceEncodingReceiptHash:receiptHash});
 progress.batches[0]={...progress.batches[0],resultHash,inputHash:digest('page input'),copyIndices:[0]};
 // A verified blank page has no remote result, even in published provenance.
 progress.batches[1]={...progress.batches[1],inputHash:digest('blank page input'),copyIndices:[1]};
 return {binding,dictionary,dictionaryHash,receiptHash,resultHash,progress};
}

test('declared progress, font proof and dictionary are retained without treating embedded hashes as blobs',async()=>{
 const f=await fixture(),reads:string[]=[];
 const hashes=await parsingProvenanceBlobHashes(f.progress,f.binding,async hash=>{reads.push(hash);return readBlob(hash);});
 assert.deepEqual(new Set(hashes),new Set([f.resultHash,f.receiptHash,f.dictionaryHash]));
 assert.deepEqual(new Set(reads),new Set([f.receiptHash,f.dictionaryHash]),'no original PDF or large result read is needed');
 assert.deepEqual(await parsingProvenanceBlobHashes({sourceEncoding:{receiptHash:f.receiptHash}},f.binding),[f.receiptHash,f.dictionaryHash]);
});

test('mixed page repair and typed replay manifests keep all explicit artifact kinds',async()=>{
 const f=await fixture(),kinds=['native-before','native-after','native-before-receipt','native-after-receipt',
  'source-font-proof-raw','source-font-proof','derived-native-input','native-projection-receipt'];
 const references=await Promise.all(kinds.map(async kind=>({kind,sha256:await storeDoclingResult({kind})})));
 const nativeVersionReceiptSha256=await storeDoclingResult({nativeVersion:'preserved'});
 const source={kind:'mixed-original-native-page-repair-v1',source:{sourceHash:f.binding.sourceHash,documentId:f.binding.documentId},
  referenceDictionarySha256:f.dictionaryHash,nativeVersionReceiptSha256,sourceEncoding:[{physicalPage:1,references}]};
 const receiptHash=await storeDoclingResult(source);
 const mixed={receiptHash,sourceEncoding:source};
 assert.deepEqual(new Set(await parsingProvenanceBlobHashes(mixed,f.binding)),
  new Set([receiptHash,f.dictionaryHash,nativeVersionReceiptSha256,...references.map(r=>r.sha256)]));
 const text=Buffer.from('saved original paragraph'),hash=await saveBlob(text);
 assert.deepEqual(await parsingProvenanceBlobHashes({kind:'cached-page-replay',blobReferences:[{kind:'decoder-output-page',sha256:hash,byteLength:text.length}]},f.binding),[hash]);
 await assert.rejects(parsingProvenanceBlobHashes({...mixed,sourceEncoding:{...source,source:{...source.source,sourceHash:'a'.repeat(64)}}},f.binding),/identity differs/);
 await assert.rejects(parsingProvenanceBlobHashes({blobReferences:[{kind:'raw',sha256:hash,byteLength:0}]},f.binding),/typed/);
});

test('real PG history and hidden sources retain proof after job removal; missing proof stops scratch collection',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();
 const f=await fixture(),{binding}=f;
 const {queueIngestionJob,doclingStageBlobHashes}=await import('../lib/kernel/jobs.ts');
 const job=await queueIngestionJob('docling_document','upload','retention-test',
  {owner:binding.owner,id:binding.documentId,sourceHash:binding.sourceHash,doclingProgress:f.progress},randomUUID());
 assert.ok((await doclingStageBlobHashes()).includes(f.dictionaryHash),'staged proof dependency is protected too');
 const document={id:binding.documentId,ownerId:binding.owner,courseId:'',name:'retention fixture',hash:binding.sourceHash,
  mime:'text/plain',origin:'upload',originKey:binding.documentId};
 const pages=[{pageNumber:1,locator:'original page 1',text:'Original content'},{pageNumber:2,locator:'blank original page 2',text:''}];
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'retention-test-v1',batchProvenance:f.progress});
 await kernel.ingestParsedDocument(document,[{...pages[0],text:'Revised current content'},pages[1]],{parserVersion:'retention-test-v2'});
 await kernel.hideParsedDocument(binding.owner,binding.documentId);
 await kernelPool().query('DELETE FROM ingestion_jobs WHERE id=$1',[job]);
 const retained=await kernel.publishedDocumentBlobHashes();
 for(const hash of [binding.sourceHash,f.resultHash,f.receiptHash,f.dictionaryHash])assert.ok(retained.includes(hash));
 const orphan=await saveBlob(Buffer.from('unreferenced old artifact '+randomUUID()));
 assert.ok(await collectUnusedBlobs(Date.now()+2*86400000)>0);
 await assert.rejects(readBlob(orphan));
 for(const hash of [binding.sourceHash,f.resultHash,f.receiptHash,f.dictionaryHash])assert.ok((await readBlob(hash)).length);
 const pending=await saveBlob(Buffer.from('must survive incomplete proof '+randomUUID()));
 await unlink(join(directory,f.receiptHash));
 assert.equal(await collectUnusedBlobs(Date.now()+2*86400000),0);
 assert.ok((await readBlob(pending)).length);
});
