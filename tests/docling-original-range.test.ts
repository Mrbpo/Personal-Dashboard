import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,saveBlob} from '../lib/library.ts';
import {stageOriginalDoclingRange,type OriginalDoclingRangeInput} from '../lib/kernel/docling-original-range.ts';
import {readDoclingPageRegions,doclingPageResultReferences} from '../lib/kernel/docling-source-regions.ts';
import {indexDoclingPageRegions,validateOriginalDoclingPageRange} from '../lib/kernel/docling-result.ts';

process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=await mkdtemp(join(tmpdir(),'docling-original-range-'));
const document={schema_name:'DoclingDocument',version:'1.0',origin:{mimetype:'application/pdf',binary_hash:''},body:{self_ref:'#/body',children:[{$ref:'#/texts/0'}]},
 groups:[],pictures:[],tables:[],texts:[{self_ref:'#/texts/0',parent:{$ref:'#/body'},children:[],label:'text',
  orig:'The synthetic method applies to both named datasets.',text:'The synthetic method applies to both named datasets.',
  prov:[{page_no:7,bbox:{l:10,t:90,r:90,b:10,coord_origin:'BOTTOMLEFT'},charspan:[0,50]}]}],
 pages:{7:{page_no:7,size:{width:100,height:100}}}};
const pdf=await PDFDocument.create();for(let i=0;i<8;i++)pdf.addPage([100,100]);const original=await pdf.save(),hash=digest(original);
document.origin.binary_hash=hash;
const exportHash=await saveBlob(Buffer.from(JSON.stringify(document))),input:OriginalDoclingRangeInput={owner:'owner',documentId:'document',
  sourceHash:hash,expectedCurrentVersion:'a'.repeat(64),rawExportSha256:exportHash,pageRange:[7,7],
  producer:{imageDigest:'sha256:'+'b'.repeat(64),packages:{'docling-slim':'fixture'},configuration:{page_range:[7,7]},conversionStatus:'unknown'}},
 source={owner:'owner',documentId:'document',sourceHash:hash,pageCount:8,physicalPage:7};

test('cached original range keeps page 7, actual original hash, raw export and unknown producer status',async()=>{
 const staged=await stageOriginalDoclingRange(input,original),observation=await readDoclingPageRegions(source,staged.reference);
 assert.deepEqual(staged.decoded.pages.map(p=>p.pageNumber),[7]);assert.equal(staged.decoded.pages[0].text,document.texts[0].text);
 assert.deepEqual(staged.reference.copyIndices,[0,1,2,3,4,5,6,7]);assert.equal(staged.reference.derivedInputSha256,hash);
 assert.equal(observation.derivedPage,7);assert.equal(observation.physicalPage,7);
 assert.deepEqual(observation.nodes.find(n=>n.reference==='#/texts/0')?.physicalPageNumbers,[7]);
 assert.equal(observation.semanticRelationsVerified,false);assert.equal(observation.textFaithfulnessVerified,false);
 const saved=JSON.parse(Buffer.from(await readFile(join(process.env.LIBRARY_DIR!,staged.reference.resultBlobSha256))).toString());
 assert.equal(saved.producer.conversionStatus,'unknown');assert.equal(saved.producer.rawExportSha256,exportHash);
 assert.equal(saved.producer.statusMeaning,'adapter-schema-and-page-coverage-valid');
 assert.equal(digest(await readFile(join(process.env.LIBRARY_DIR!,exportHash))),exportHash);
 assert.ok(staged.batchProvenance.blobReferences.some(r=>r.sha256===exportHash));
});

test('an undeclared range, renumbering, another page or derived input cannot acquire original range provenance',async()=>{
 const staged=await stageOriginalDoclingRange(input,original),result={status:'success',errors:[],document:{json_content:document}};
 assert.throws(()=>indexDoclingPageRegions(result,7,8),/coverage/);
 assert.throws(()=>validateOriginalDoclingPageRange([7,7],{sourceHash:hash,inputHash:'c'.repeat(64),pageCount:8,copyIndices:[6]}),/mapping/);
 assert.deepEqual(doclingPageResultReferences({...source,physicalPage:6},null,{status:'unavailable',regions:[],pageSizes:[],resultReferences:[staged.reference]}),[]);
 await assert.rejects(readDoclingPageRegions({...source,physicalPage:6},staged.reference),/outside/);
 const renumbered=structuredClone(document);renumbered.pages={1:{...document.pages[7],page_no:1}} as unknown as typeof document.pages;
 renumbered.texts[0].prov[0].page_no=1;
 const badHash=await saveBlob(Buffer.from(JSON.stringify(renumbered)));
 await assert.rejects(stageOriginalDoclingRange({...input,rawExportSha256:badHash},original),/manifest/);
});

test('foreign owner and changed cached range/hash are rejected without parsing or source rewriting',async()=>{
 const staged=await stageOriginalDoclingRange(input,original);
 await assert.rejects(readDoclingPageRegions({...source,owner:'another-owner'},staged.reference),/mapping/);
 const saved=JSON.parse((await readFile(join(process.env.LIBRARY_DIR!,staged.reference.resultBlobSha256))).toString());
 saved.identity.resultPageRange=[8,8];const changed=await saveBlob(Buffer.from(JSON.stringify(saved)));
 await assert.rejects(readDoclingPageRegions(source,{...staged.reference,resultBlobSha256:changed}),/mapping/);
 const path=join(process.env.LIBRARY_DIR!,staged.reference.resultBlobSha256),before=await readFile(path);
 await writeFile(path,Buffer.concat([before,Buffer.from(' ')]));
 try{await assert.rejects(readDoclingPageRegions(source,staged.reference),/checksum/);}finally{await writeFile(path,before);}
 assert.equal(digest(original),hash);
});

test('malformed source-adapter JSON cannot bypass the explicit original-range contract',async()=>{
 for(const changed of [{...input,owner:'owner\0foreign'},{...input,producer:undefined},{...input,pageRange:undefined}])
  await assert.rejects(stageOriginalDoclingRange(changed as unknown as OriginalDoclingRangeInput,original),/Invalid cached original/);
});

test('an export from another original is rejected and actual uint64 JSON origin hashes are lossless',async()=>{
 const other=structuredClone(document);other.origin.binary_hash='d'.repeat(64);
 const wrong=await saveBlob(Buffer.from(JSON.stringify(other)));
 await assert.rejects(stageOriginalDoclingRange({...input,rawExportSha256:wrong},original),/origin/);
 const integer=(BigInt('0x'+hash)&BigInt('0xffffffffffffffff')).toString(),raw=JSON.stringify(document).replace('"binary_hash":"'+hash+'"','"binary_hash":'+integer),
  exact=await saveBlob(Buffer.from(raw));
 assert.equal((await stageOriginalDoclingRange({...input,rawExportSha256:exact},original)).reference.derivedInputSha256,hash);
});
