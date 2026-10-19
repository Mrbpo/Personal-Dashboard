import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {digest,saveBlob} from '../lib/library.ts';
import {decodeDerivedDoclingResult} from '../lib/kernel/docling-batches.ts';
import {prepareNativeTableArtifact,nativeTableSearchStrings,prepareNativeTableCandidates,commitNativeTableCandidates,
 prepareNativeTableObservation} from '../lib/kernel/document-table-candidates.ts';
import {prepareSourceValueCatalog} from '../lib/kernel/document-source-values.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel,kernelTransaction} from '../lib/kernel/db.ts';
import {prepareDocumentAnswer} from '../lib/kernel/document-answer.ts';
import {documentSearchTerms} from '../lib/kernel/document-search.ts';
import type {DocumentSelectedNodeHit} from '../lib/kernel/document-evidence.ts';
import type {PdfVisualImageEvidence} from '../lib/kernel/pdf-visual-evidence.ts';

let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw new Error('Native tables prohibit external calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});

/** Synthetic plumbing fixture, not a measured Docling transcription. */
function syntheticTable(){
 const cell=(text:string,r:number,c:number,extra:Record<string,unknown>={})=>({text,start_row_offset_idx:r,
  end_row_offset_idx:r+1,start_col_offset_idx:c,end_col_offset_idx:c+1,row_span:1,col_span:1,...extra});
 const cells=[cell(' measure | raw\nunits ',0,0,{column_header:true,col_span:2,end_col_offset_idx:2}),
  cell('Count',1,0,{row_header:true}),cell(' 007 ',1,1),cell('',2,0),cell('3.0%',2,1)];
 return {status:'success',document:{json_content:{pages:{1:{page_no:1}},
  body:{children:[{$ref:'#/tables/0'}]},tables:[{self_ref:'#/tables/0',prov:[{page_no:1}],
   captions:[{$ref:'#/texts/0'}],data:{num_rows:3,num_cols:2,table_cells:cells}}],
  texts:[{text:'Table 1. Printed caption.',prov:[{page_no:1}]}]}}};
}
function decodedFixture(){
 const raw=syntheticTable(),decoded=decodeDerivedDoclingResult(raw,{start:5,end:5,totalPages:7,copyIndices:[4]},
  {verifiedBlankPages:[],formulaEnriched:false});
 const table=decoded.nativeTables[0];table.result={resultBlobSha256:'a'.repeat(64),derivedInputSha256:'b'.repeat(64),
  optionsHash:'c'.repeat(64),copyIndices:[4]};
 return {raw,decoded,table};
}
async function realFixture(){
 const dir=resolve('tests/fixtures/native-table-mit-class5');
 const [raw,pdf,png,provenance]=await Promise.all(['result.json','source-page.pdf','source-page.png','provenance.json'].map(name=>readFile(resolve(dir,name))));
 const metadata=JSON.parse(provenance.toString('utf8'));
 assert.equal(digest(raw),metadata.rawResultSha256);assert.equal(digest(pdf),metadata.sourcePdfSha256);assert.equal(digest(png),metadata.sourcePngSha256);
 return {raw:JSON.parse(raw.toString('utf8')),pdf,png,metadata};
}

test('native synthetic grid preserves raw cells, explicit spans, blanks and original page mapping without changing page text',()=>{
 const {raw,decoded,table}=decodedFixture();
 assert.equal(decoded.pages[0].pageNumber,5);assert.deepEqual(table.pageNumbers,[5]);
 assert.deepEqual(table.raw,raw.document.json_content.tables[0]);
 assert.equal(table.cellTexts[0].text,' measure | raw\nunits ');
 assert.equal(table.cellTexts[2].text,' 007 ');assert.equal(table.cellTexts[3].text,'');
 assert.equal(decoded.pages[0].text,'|  measure \\| raw units  |  |\n| Count |  007  |\n|  | 3.0% |\n\nTable 1. Printed caption.');
 const artifact=prepareNativeTableArtifact(table);
 assert.equal(artifact.status,'available');assert.deepEqual(artifact.reasons,[]);
 assert.equal(nativeTableSearchStrings(artifact),' measure | raw\nunits \nCount\n 007 \n\n3.0%\nTable 1. Printed caption.');
 assert.deepEqual(documentSearchTerms('What is the Gaussian surface of the sphere?').words,['gaussian','surface','sphere']);
 assert.notEqual(artifact.native.raw,table.raw);
 assert.equal(artifact.artifactSha256,prepareNativeTableArtifact(table).artifactSha256);
});

test('unsupported grid metadata stays unavailable without rejecting otherwise readable source text or inferring cells',()=>{
 const {table}=decodedFixture();
 const bad=structuredClone(table),data=bad.raw.data as {table_cells:Record<string,unknown>[]};
 delete data.table_cells[0].col_span;delete data.table_cells[0].end_col_offset_idx;
 const artifact=prepareNativeTableArtifact(bad);
 assert.equal(artifact.status,'unavailable');assert.ok(artifact.reasons.includes('unsupported-cell-structure'));
 assert.equal(nativeTableSearchStrings(artifact),'');
 const missing=structuredClone(table);delete missing.result;
 assert.ok(prepareNativeTableArtifact(missing).reasons.includes('raw-result-identity-unavailable'));
 assert.notEqual(artifact.artifactSha256,prepareNativeTableArtifact(table).artifactSha256);
});

test('saved real MIT native table keeps all raw fields and its upstream original-page mapping without correcting typography',async()=>{
 const f=await realFixture(),decoded=decodeDerivedDoclingResult(f.raw,{start:2,end:2,totalPages:2,copyIndices:[1]},
  {verifiedBlankPages:[],formulaEnriched:false});
 assert.equal((await PDFDocument.load(f.pdf)).getPageCount(),1);
 assert.deepEqual(decoded.nativeTables[0].raw,f.raw.document.json_content.tables[0]);
 assert.deepEqual(decoded.nativeTables[0].pageNumbers,[2]);assert.equal(decoded.pages[0].pageNumber,2);
 const cells=f.raw.document.json_content.tables[0].data.table_cells;
 assert.equal(cells.length,12);assert.deepEqual(decoded.nativeTables[0].cellTexts,cells.map((cell:{text:string},index:number)=>({cellIndex:index,text:cell.text})));
 assert.equal(decoded.nativeTables[0].cellTexts[8].text,"Gaussian 'Pillbox'");
});

test('supplemental current page anchors bind real PNGs without creating text supports or replacing protected text',async()=>{
 const f=await realFixture(),decoded=decodeDerivedDoclingResult(f.raw,{start:1,end:1,totalPages:1,copyIndices:[0]},
  {verifiedBlankPages:[],formulaEnriched:false});
 const source={documentId:'fixture-doc',currentVersionId:'fixture-version',sourceVersionId:'fixture-source',sourceHash:digest(f.pdf),courseId:''};
 const node:DocumentSelectedNodeHit={id:'pg:fixture-version:1',document_id:source.documentId,source_version_id:source.sourceVersionId,
  source_hash:source.sourceHash,course_id:'',name:'Saved MIT Class 5',origin:'public-fixture',origin_key:'mit-class5',
  body:decoded.pages[0].text,locator:'第 1 页',page_number:1,evidence_id:'fixture-evidence',parser_version:'saved-real-native',
  reader_selection:'evidence-node-ids',retrieval_mode:'reader-selection',evidence_body:'full-page'};
 const image:PdfVisualImageEvidence={kind:'pdf-page',physicalPage:1,attachmentId:digest('fixture-attachment'),assetId:digest(f.png),
  anchorEvidenceId:node.evidence_id,rawPdfSha256:source.sourceHash,manifestSha256:digest('fixture-manifest'),source,mime:'image/png',
  sha256:digest(f.png),byteLength:f.png.length,width:f.png.readUInt32BE(16),height:f.png.readUInt32BE(20),bytes:f.png,
  provenance:{rawPdfSha256:source.sourceHash,pageRenderSha256:digest(f.png),pageSizePoints:{width:612,height:792},rotation:0,
   rendererPolicy:'already-rendered-public-fixture',sourcePageCropBox:{x:0,y:0,width:612,height:792}}};
 const context={anchors:[],parents:[],imageAnchors:[node],images:[image],sourceContentIsUntrusted:true as const};
 const prepared=prepareDocumentAnswer('Which Gaussian surfaces?',context);
 assert.deepEqual(prepared.quoteUnits,[]);assert.deepEqual(prepared.supports.map(s=>s.kind),['image']);
 assert.equal(JSON.stringify(prepared.input).includes("Gaussian 'Pillbox'"),false);
 assert.deepEqual(prepareDocumentAnswer('Which?',{...context,images:[]}).supports,[],'missing image cannot fall back to native/body text');
 assert.throws(()=>prepareDocumentAnswer('Which?',{...context,images:[{...image,physicalPage:2}]}),/genuine current page/);
 const protectedContext={...context,anchors:[node]},protectedResult=prepareDocumentAnswer('Which?',protectedContext);
 assert.deepEqual(protectedResult.supports.map(s=>s.kind),['text','image']);
 assert.ok(protectedResult.quoteUnits.length>0);assert.equal(protectedResult.supports[0].text,node.body);
 // Controlled parser omission on the saved original page: not a new parsing
 // fidelity result. The missing cell stays missing and no grid becomes usable.
 const partial=structuredClone(decoded.nativeTables[0]);
 (partial.raw.data as {table_cells:unknown[]}).table_cells.shift();
 partial.cellTexts=partial.cellTexts.slice(1).map((cell,index)=>({...cell,cellIndex:index}));
 partial.result={resultBlobSha256:digest('controlled-partial-result'),derivedInputSha256:source.sourceHash,
  optionsHash:digest('fixture-options'),copyIndices:[0]};
 const artifact=prepareNativeTableArtifact(partial);assert.deepEqual(artifact.reasons,['incomplete-grid']);
 const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
  Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
 const binding={namespace:artifact.namespace,producer:artifact.producer,source,artifactSha256:artifact.artifactSha256,
  manifestSha256:image.manifestSha256,assetSha256:image.sha256,anchor:image.anchorEvidenceId};
 const candidate={kind:'derived-native-table' as const,id:digest(canonical(binding)),source,pageNumber:1,anchorEvidenceId:image.anchorEvidenceId,
  manifestSha256:image.manifestSha256,assetSha256:image.sha256,artifactSha256:artifact.artifactSha256};
 const observation=prepareNativeTableObservation(candidate,artifact,image);
 assert.equal(observation.status,'unavailable');assert.equal(observation.reason,'incomplete-grid');assert.equal(observation.native,undefined);
 assert.equal(observation.relationshipVerified,false);assert.equal(observation.nativeSha256,digest(canonical(partial)));
 const observed=prepareDocumentAnswer('Which?',{...context,images:[{...image,tableObservations:[observation]}]});
 assert.equal(JSON.stringify(observed.input).includes("Gaussian 'Pillbox'"),false,'search hints never become textual evidence');
 const catalog=prepareSourceValueCatalog(observed.supports);assert.equal(catalog.status,'unavailable');assert.deepEqual(catalog.cells,[]);
 assert.throws(()=>prepareNativeTableObservation(candidate,artifact,{...image,physicalPage:2}));
 const invalid=structuredClone(partial);(invalid.raw.data as {table_cells:Record<string,unknown>[]}).table_cells[0].row_span=999;
 assert.throws(()=>prepareNativeTableObservation(candidate,prepareNativeTableArtifact(invalid),image),'other structure failures remain rejected');
});

test('isolated saved-real native projection recalls true page PNG only; foreign/stale sources and invalid assets cannot support an answer',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 const {preparePdfVisualEvidence}=await import('../lib/kernel/pdf-visual-evidence.ts');
 await migrateKernel();const pool=kernelPool(),tag=randomUUID(),owner='native-table-'+tag,id='native-table-doc-'+tag;
 const fixture=await realFixture(),original=fixture.pdf,sourceHash=await saveBlob(original),optionsHash=digest(JSON.stringify(fixture.metadata.conversion));
 const inputRaw=fixture.raw,decoded=decodeDerivedDoclingResult(inputRaw,{start:1,end:1,totalPages:1,copyIndices:[0]},
  {verifiedBlankPages:[],formulaEnriched:false});
 const wrapper={identity:{owner,documentId:id,sourceHash,totalPages:1,optionsHash,inputHash:sourceHash,copyIndices:[0]},result:inputRaw};
 const rawSha=await saveBlob(Buffer.from(JSON.stringify(wrapper)));
 const table=decoded.nativeTables[0];table.result={resultBlobSha256:rawSha,derivedInputSha256:sourceHash,optionsHash,copyIndices:[0]};
 const nativeTables=await prepareNativeTableCandidates({owner,documentId:id,sourceHash,tables:[table]});
 assert.equal(nativeTables.artifacts[0].status,'available');
 const forged=structuredClone(table);forged.cellTexts[0].text='Invented cell';
 assert.ok((await prepareNativeTableCandidates({owner,documentId:id,sourceHash,tables:[forged]})).artifacts[0].reasons.includes('raw-result-unverified'));
 const png=fixture.png;
 const visuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:original,
  layout:{status:'unavailable',regions:[],pageSizes:[],reason:'Saved real page PNG supplied by offline fixture'}},async()=>png);
 const doc={id,ownerId:owner,courseId:'',name:'Saved MIT class5 table '+tag,hash:sourceHash,mime:'application/pdf',origin:'public-fixture',originKey:id};
 const pages=decoded.pages;
 await kernel.ingestParsedDocument(doc,pages,{parserVersion:'saved-real-native',pdfVisuals:visuals,nativeTables});
 const hits=await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox');assert.equal(hits.length,1);
 assert.deepEqual(await kernel.searchNativeTableCandidates(owner,'what is the of'),[]);
 const {courseId:_course,...omittedCourse}=hits[0].source;
 await kernelTransaction(client=>commitNativeTableCandidates(client,nativeTables,omittedCourse,[hits[0].anchorEvidenceId]));
 assert.equal((await pool.query('SELECT count(*) n FROM document_table_candidates WHERE version_id=$1',[hits[0].source.currentVersionId])).rows[0].n,'1');
 assert.deepEqual(await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox'),hits);
 await assert.rejects(kernelTransaction(client=>commitNativeTableCandidates(client,nativeTables,
  {...omittedCourse,courseId:'foreign-course'},[hits[0].anchorEvidenceId])));
 assert.equal('body' in hits[0],false);assert.equal('cellTexts' in hits[0],false);
 const row=(await pool.query('SELECT * FROM document_table_candidates WHERE id=$1',[hits[0].id])).rows[0];
 assert.equal(row.raw_result_sha256,rawSha);assert.equal(row.artifact.native.raw.data.table_cells[8].text,"Gaussian 'Pillbox'");
 assert.equal((await kernel.parsedDocument(owner,id))[0].body,pages[0].text);
 assert.equal((await pool.query('SELECT count(*) n FROM evidence WHERE source_version_id=$1',[hits[0].source.sourceVersionId])).rows[0].n,'1');
 const evidence=await kernel.readNativeTableCandidateEvidence(owner,hits);
 assert.equal(evidence.imageAnchors[0].evidence_id,hits[0].anchorEvidenceId);assert.equal(evidence.images[0].kind,'pdf-page');
 assert.equal(evidence.images[0].tableObservations?.[0].status,'available');
 assert.deepEqual(evidence.images[0].tableObservations?.[0].native,row.artifact.native);
 const prepared=prepareDocumentAnswer('What does the table report?',{anchors:[],parents:[],...evidence,sourceContentIsUntrusted:true});
 assert.deepEqual(prepared.quoteUnits,[]);assert.equal(prepared.supports.length,1);assert.equal(prepared.supports[0].kind,'image');
 assert.equal(JSON.stringify(prepared.input).includes("Gaussian 'Pillbox'"),true,'current native declaration enters image metadata only');
 assert.equal(prepared.input.evidence[0].tableObservations?.[0].semanticVerified,false);
 assert.deepEqual(await kernel.searchNativeTableCandidates('foreign-owner','Gaussian Pillbox'),[]);
 await assert.rejects(kernel.readNativeTableCandidateEvidence('foreign-owner',hits));
 await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,[{...hits[0],source:{...hits[0].source,courseId:'foreign-course'}}]));
 const path=resolve(process.env.LIBRARY_DIR||'./data/library',evidence.images[0].sha256),bytes=await readFile(path);
 try{await writeFile(path,'corrupt original PNG');await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,hits),/checksum/);}
 finally{await writeFile(path,bytes);}
 const moved=path+'.native-test-'+tag;
 try{await rename(path,moved);await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,hits),/missing/);}
 finally{await rename(moved,path);}
 await pool.query('UPDATE document_table_candidates SET asset_sha256=$2 WHERE id=$1',[hits[0].id,'f'.repeat(64)]);
 await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,hits));
 await pool.query('UPDATE document_table_candidates SET asset_sha256=$2 WHERE id=$1',[hits[0].id,hits[0].assetSha256]);
 await pool.query('UPDATE document_texts SET hidden=true WHERE id=$1',[id]);
 assert.deepEqual(await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox'),[]);
 await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,hits));
 await pool.query('UPDATE document_texts SET hidden=false WHERE id=$1',[id]);
 await kernel.ingestParsedDocument(doc,[{...pages[0],text:'New current version.'}],{parserVersion:'saved-real-native-v2',pdfVisuals:visuals});
 assert.deepEqual(await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox'),[]);
 await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,hits));
 // A controlled incomplete-grid result cannot enter ordinary/global search.
 // An explicit current document can recover the original page within the same
 // supplement bound, with the grid still unavailable to structured operators.
 const partialRaw=structuredClone(inputRaw);partialRaw.document.json_content.tables[0].data.table_cells.shift();
 const partialDecoded=decodeDerivedDoclingResult(partialRaw,{start:1,end:1,totalPages:1,copyIndices:[0]},
  {verifiedBlankPages:[],formulaEnriched:false});
 const partialSha=await saveBlob(Buffer.from(JSON.stringify({identity:wrapper.identity,result:partialRaw}))),partialTable=partialDecoded.nativeTables[0];
 partialTable.result={resultBlobSha256:partialSha,derivedInputSha256:sourceHash,optionsHash,copyIndices:[0]};
 const partialTables=await prepareNativeTableCandidates({owner,documentId:id,sourceHash,tables:[partialTable]});
 assert.deepEqual(partialTables.artifacts[0].reasons,['incomplete-grid']);
 await kernel.ingestParsedDocument(doc,partialDecoded.pages,{parserVersion:'controlled-incomplete-grid',pdfVisuals:visuals,nativeTables:partialTables});
 assert.deepEqual(await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox'),[]);
 const fallback=await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox',{documentId:id});assert.equal(fallback.length,1);
 assert.deepEqual(await kernel.searchNativeTableCandidates('foreign-owner','Gaussian Pillbox',{documentId:id}),[]);
 const fallbackEvidence=await kernel.readNativeTableCandidateEvidence(owner,fallback),observation=fallbackEvidence.images[0].tableObservations![0];
 assert.equal(fallbackEvidence.images[0].sha256,digest(png));assert.equal(observation.status,'unavailable');assert.equal(observation.reason,'incomplete-grid');
 assert.equal(observation.native,undefined);assert.equal(observation.relationshipVerified,false);
 const bound=prepareDocumentAnswer('What is printed?',{anchors:[],parents:[],...fallbackEvidence,sourceContentIsUntrusted:true});
 assert.deepEqual(bound.quoteUnits,[]);assert.deepEqual(prepareSourceValueCatalog(bound.supports).cells,[]);
 const unchanged=(await pool.query('SELECT status,search_text,artifact FROM document_table_candidates WHERE id=$1',[fallback[0].id])).rows[0];
 assert.equal(unchanged.status,'unavailable');assert.equal(unchanged.search_text,'');assert.deepEqual(unchanged.artifact.reasons,['incomplete-grid']);
 await assert.rejects(kernel.readNativeTableCandidateEvidence('foreign-owner',fallback));
 await pool.query('UPDATE document_texts SET hidden=true WHERE id=$1',[id]);
 assert.deepEqual(await kernel.searchNativeTableCandidates(owner,'Gaussian Pillbox',{documentId:id}),[]);
 await assert.rejects(kernel.readNativeTableCandidateEvidence(owner,fallback));
 assert.ok((await kernel.nativeTableBlobHashes()).includes(rawSha));
});
