import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {decodeDoclingResult} from '../lib/kernel/docling-result.ts';
import {decodeDerivedDoclingResult,storeDoclingResult,createDoclingProgress} from '../lib/kernel/docling-batches.ts';
import {decodeCachedDoclingReplay,auditCachedDoclingReplay,applyCachedDoclingReplay} from '../lib/kernel/docling-cache-replay.ts';
import {preparePdfVisualEvidence,readPdfVisualEvidence,PdfVisualEvidenceError,PDF_VISUAL_READ_LIMITS} from '../lib/kernel/pdf-visual-evidence.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const fixture=async(name:string)=>JSON.parse(await readFile(new URL(`./fixtures/pdf-layout/${name}.json`,import.meta.url),'utf8'));
const unavailable={status:'unavailable' as const,regions:[],pageSizes:[],reason:'Native text has no layout conversion'};
let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw new Error('PDF visual fixture forbids external calls');};
after(async()=>{assert.equal(externalCalls,0);if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});

test('two actual completed Docling fixtures preserve bbox/origin/size; copied page5 remains physical5',async()=>{
 for(const name of ['mit-chem-lec4-page1','mit-chem-lec2-page1']){
  const raw=await fixture(name),decoded=decodeDoclingResult(raw,1,{formulaEnriched:false});
  assert.equal(decoded.visualLayout.status,'available');assert.equal(decoded.visualLayout.regions.length,1);
  const region=decoded.visualLayout.regions[0],original=raw.document.json_content.pictures[0].prov[0];
  assert.deepEqual(region.bbox,original.bbox);assert.deepEqual(region.pageSize,{width:612,height:792});
  assert.ok(region.textReferences.length>0);
  const mapped=decodeDerivedDoclingResult(raw,{start:5,end:5,totalPages:7,copyIndices:[4]},{formulaEnriched:false,verifiedBlankPages:[]});
  assert.equal(mapped.visualLayout.regions[0].pageNumber,5);assert.equal(mapped.visualLayout.regions[0].derivedPageNumber,1);
  assert.deepEqual(mapped.visualLayout.regions[0].bbox,original.bbox);assert.deepEqual(mapped.visualLayout.regions[0].copyIndices,[4]);
  const invalid=structuredClone(raw);invalid.document.json_content.pictures[0].prov[0].bbox.l=900;
  assert.throws(()=>decodeDoclingResult(invalid),/bbox exceeds/);
 }
});

async function source(pages=1){const pdf=await PDFDocument.create();for(let i=0;i<pages;i++)pdf.addPage([612,792]);return pdf.save();}
const png=async()=>sharp({create:{width:612,height:792,channels:3,background:'#abcdef'}}).png().toBuffer();
async function stagedFixture(twoRegions=false,disabled=false){
 const owner='pdf-owner-'+randomUUID(),id='pdf-'+randomUUID(),bytes=await source(),sourceHash=hash(bytes),raw=await fixture('mit-chem-lec4-page1');
 if(twoRegions){const doc=raw.document.json_content,copy=structuredClone(doc.pictures[0]);copy.self_ref='#/pictures/1';copy.children=[];
  copy.prov[0].bbox={l:10,t:750,r:110,b:650,coord_origin:'BOTTOMLEFT'};doc.pictures.push(copy);doc.body.children.push({$ref:'#/pictures/1'});}
 const resultHash=await storeDoclingResult({identity:{owner,documentId:id,sourceHash,totalPages:1,inputHash:sourceHash,copyIndices:[0]},result:raw});
 const layout=decodeDoclingResult(raw,1,{formulaEnriched:false}).visualLayout;
 layout.resultReferences=[{resultBlobSha256:resultHash,derivedInputSha256:sourceHash,copyIndices:[0]}];
 layout.regions=layout.regions.map(region=>({...region,resultBlobSha256:resultHash,derivedInputSha256:sourceHash,copyIndices:[0]}));
 const image=await png();let renders=0;
 const prepared=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout},async()=>{renders++;return disabled?null:image;});
 return {owner,id,bytes,sourceHash,raw,resultHash,layout,image,prepared,renders};
}

test('exact crop pixels, staged replay and interrupted-page reuse; unavailable render retains real layout',async()=>{
 const item=await stagedFixture();assert.equal(item.renders,1);assert.equal(item.prepared.content.assets.length,2);
 const region=item.prepared.content.assets.find(asset=>asset.kind==='pdf-region')!;
 const [l,t,r,b]=region.provenance.region!.cropPixelBox;
 const actual=await readFile(resolve(process.env.LIBRARY_DIR||'./data/library',region.sha256));
 assert.deepEqual(await sharp(actual).raw().toBuffer(),await sharp(item.image).extract({left:l,top:t,width:r-l,height:b-t}).raw().toBuffer());
 const repeat=await preparePdfVisualEvidence({owner:item.owner,documentId:item.id,sourceHash:item.sourceHash,pdfBytes:item.bytes,layout:item.layout},async()=>{throw new Error('Completed page must not be rerendered');});
 assert.equal(repeat.contentSha256,item.prepared.contentSha256);
 const altered=structuredClone(item.layout);altered.regions[0].bbox.r--;
 await assert.rejects(preparePdfVisualEvidence({owner:item.owner,documentId:item.id,sourceHash:item.sourceHash,pdfBytes:item.bytes,layout:altered},async()=>item.image),/not in its actual saved Docling/);
 const noRenderer=(await stagedFixture(false,true)).prepared;
 assert.equal(noRenderer.content.renderStatus,'unavailable');assert.equal(noRenderer.content.layout.regions.length,1);
 assert.equal(noRenderer.content.layout.resultReferences?.length,1);
 const bytes=await source(2),owner='resume-'+randomUUID(),id='resume-'+randomUUID(),sourceHash=hash(bytes);let calls=0;
 await assert.rejects(preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout:unavailable},async()=>{calls++;if(calls===2)throw new Error('Interrupted renderer');return item.image;}),/Interrupted/);
 const resumed=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout:unavailable},async()=>{calls++;return item.image;});
 assert.equal(calls,3);assert.equal(resumed.content.assets.length,2);
});

test('one PG scenario: atomic publication/replay, real multi-region page anchors, current owner/source and answer image citations',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const item=await stagedFixture(true),pool=kernelPool(),document={id:item.id,ownerId:item.owner,courseId:'',name:item.id,
  hash:item.sourceHash,mime:'application/pdf',origin:'pdf-visual-fixture',originKey:item.id};
 const pages=[{pageNumber:1,locator:'第 1 页',text:'The original page has image evidence. Source formula must be checked against its pixels.'}];
 await pool.query(`CREATE FUNCTION reject_pdf_manifest_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture interruption'; END; $$`);
 await pool.query('CREATE TRIGGER reject_pdf_manifest_fixture BEFORE INSERT ON document_pdf_visual_manifests FOR EACH ROW EXECUTE FUNCTION reject_pdf_manifest_fixture()');
 await assert.rejects(kernel.ingestParsedDocument(document,pages,{parserVersion:'pdf-fixture-v1',pdfVisuals:item.prepared}),/fixture interruption/);
 assert.equal((await pool.query('SELECT id FROM document_texts WHERE id=$1',[item.id])).rows.length,0);
 await pool.query('DROP TRIGGER reject_pdf_manifest_fixture ON document_pdf_visual_manifests');await pool.query('DROP FUNCTION reject_pdf_manifest_fixture()');
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'pdf-fixture-v1',pdfVisuals:item.prepared});
 const resolution=await kernel.resolveDocumentSource(item.owner,{selectedDocumentTitle:item.id});assert.equal(resolution.status,'resolved');
 if(resolution.status!=='resolved')throw new Error('source');const expected={...resolution.document,courseId:''};
 const visuals=await kernel.readPdfVisualEvidence(item.owner,expected);assert.equal(visuals.images.length,3);
 assert.equal(new Set(visuals.images.map(image=>image.anchorEvidenceId)).size,1);assert.equal(visuals.images.filter(image=>image.kind==='pdf-region').length,2);
 assert.ok(visuals.images.every(image=>image.rawPdfSha256===item.sourceHash&&image.physicalPage===1));
 await assert.rejects(kernel.readPdfVisualEvidence('different-owner',expected),/not current/);
 await assert.rejects(readPdfVisualEvidence(pool,item.owner,expected,undefined,{...PDF_VISUAL_READ_LIMITS,images:1}),error=>error instanceof PdfVisualEvidenceError&&error.code==='count-limit');
 const complete=await kernel.readCompleteDocumentSource(item.owner,expected);assert.equal(complete.status,'available');
 if(complete.status!=='available')throw new Error('complete');assert.ok(complete.context.anchors.every(node=>node.evidence_body==='full-page'));
 const nodes=(await kernel.readDocumentSourcePages(item.owner,expected)).nodes;
 await assert.rejects(kernel.registerDocumentImage(item.owner,expected,{captionEvidenceId:nodes[0].evidenceId,originalReference:'fake-caption.png',
  provenance:{sourceUrl:'https://example.edu/source',revision:'fixture'},bytes:item.image}),/current caption/);
 const previous=globalThis.fetch;let mockedCalls=0;
 globalThis.fetch=async(_url,init)=>{mockedCalls++;const request=JSON.parse(String(init?.body)),input=JSON.parse(request.input[1].content[0].text);
  assert.equal(request.input[1].content.filter((part:{type:string})=>part.type==='input_image').length,3);
  const image=input.evidence.find((e:{kind:string;visual?:{kind:string}})=>e.kind==='image'&&e.visual?.kind==='pdf-region');assert.ok(image);
  return Response.json({status:'completed',model:'gpt-5-mini',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify({status:'answered',message:'',claims:[
   {text:'The provided region is preserved as image evidence.',citations:[{id:image.id}]}]})});};
 try{const result=await kernel.answerSelectedStudySource(item.owner,'Inspect the supplied region.',expected);assert.equal(result.status,'available');
  if(result.status!=='available')throw new Error('answer unavailable');assert.equal(result.result.answer.status,'answered');assert.equal(mockedCalls,1);
  assert.ok(result.result.evidence.some(e=>e.kind==='image'&&e.evidenceId===nodes[0].evidenceId&&e.locator.startsWith('pdf:page:1:')));
 }finally{globalThis.fetch=previous;}
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'pdf-fixture-v1',pdfVisuals:item.prepared});
 assert.equal((await pool.query('SELECT version_id FROM document_pdf_visual_manifests WHERE source_hash=$1',[item.sourceHash])).rows.length,1);
 await kernel.ingestParsedDocument(document,[{...pages[0],text:pages[0].text+' Updated.'}],{parserVersion:'pdf-fixture-v1',pdfVisuals:item.prepared,expectedCurrentVersion:expected.currentVersionId});
 await assert.rejects(kernel.readPdfVisualEvidence(item.owner,expected),/not current/);
 assert.equal((await pool.query('SELECT version_id FROM document_pdf_visual_manifests WHERE source_hash=$1',[item.sourceHash])).rows.length,2);
 const retained=await kernel.documentImageBlobHashes();assert.ok(retained.includes(item.resultHash));
 assert.ok(item.prepared.content.assets.every(asset=>retained.includes(asset.sha256)));
 // A ready PDF with identical cached text still needs a controlled visual-only
 // publication. Preserve text, warnings and extraction provenance; do not force
 // a new conversion or manufacture a text-quality warning to make it eligible.
 const cachedId=item.id+'-cached',original=await PDFDocument.load(item.bytes),derived=await PDFDocument.create();
 derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));derived.setProducer('Study Kernel Docling derived-v1');derived.setCreator('Study Kernel');
 for(const page of await derived.copyPages(original,[0]))derived.addPage(page);
 const identity={owner:item.owner,documentId:cachedId,sourceHash:item.sourceHash,optionsHash:hash('cached-layout-fixture'),totalPages:1};
 const progress=createDoclingProgress(identity);progress.batches[0].inputHash=hash(await derived.save());progress.batches[0].copyIndices=[0];
 progress.batches[0].resultHash=await storeDoclingResult({identity:{...identity,start:1,end:1,inputHash:progress.batches[0].inputHash,copyIndices:[0]},result:item.raw});
 await writeFile(resolve(process.env.LIBRARY_DIR||'./data/library',item.sourceHash),item.bytes);
 const decoded=await decodeCachedDoclingReplay(item.bytes,identity,progress),cachedDoc={...document,id:cachedId,name:cachedId,originKey:cachedId};
 await kernel.ingestParsedDocument(cachedDoc,decoded.pages,{parserVersion:'docling-v2-text-search',extractionMethod:'docling-text',warnings:decoded.warnings,batchProvenance:progress});
 const selected=await kernel.resolveDocumentSource(item.owner,{selectedDocumentTitle:cachedId});if(selected.status!=='resolved')throw new Error('cached source');
 const before=await kernel.readCompleteDocumentSource(item.owner,selected.document);assert.equal(before.status,'unavailable');
 if(before.status!=='unavailable')throw new Error('missing visuals accepted');assert.equal(before.reason,'image-unavailable');
 const audit=await auditCachedDoclingReplay(item.owner,cachedId);assert.deepEqual(audit.changedPages,[]);assert.equal(audit.visualOnly,true);
 assert.equal(audit.visualEvidence.status,'missing');assert.equal(audit.decision,'eligible');assert.deepEqual(audit.warnings,[...new Set(decoded.warnings)].sort());
 await applyCachedDoclingReplay(audit,audit.expectedCurrentVersion,async()=>null);
 const incomplete=await auditCachedDoclingReplay(item.owner,cachedId);assert.equal(incomplete.visualEvidence.status,'render-incomplete');
 assert.equal(incomplete.decision,'eligible');assert.equal(incomplete.visualOnly,true);assert.deepEqual(incomplete.warnings,audit.warnings);
 const incompleteCount=(await pool.query<{count:number}>('SELECT count(*)::int count FROM document_text_versions WHERE document_id=$1',[cachedId])).rows[0].count;
 const stillUnavailable=await applyCachedDoclingReplay(incomplete,incomplete.expectedCurrentVersion,async()=>null);
 assert.equal(stillUnavailable.action,'unchanged');assert.equal(stillUnavailable.currentVersion,incomplete.expectedCurrentVersion);
 assert.equal((await pool.query<{count:number}>('SELECT count(*)::int count FROM document_text_versions WHERE document_id=$1',[cachedId])).rows[0].count,incompleteCount);
 const incompleteSource=await kernel.resolveDocumentSource(item.owner,{selectedDocumentTitle:cachedId});
 if(incompleteSource.status!=='resolved')throw new Error('incomplete source');
 assert.equal((await kernel.readCompleteDocumentSource(item.owner,incompleteSource.document)).status,'unavailable');
 await applyCachedDoclingReplay(incomplete,incomplete.expectedCurrentVersion,async()=>item.image);
 const after=await kernel.resolveDocumentSource(item.owner,{selectedDocumentTitle:cachedId});if(after.status!=='resolved')throw new Error('visual replay source');
 assert.equal((await kernel.readCompleteDocumentSource(item.owner,after.document)).status,'available');
 const stored=(await pool.query<{body:string;parser_version:string;warnings:string[];method:string}>(`SELECT p.body,v.parser_version,v.warnings,e.parsed_value->>'extractionMethod' method
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id JOIN evidence e ON e.id=p.evidence_id WHERE d.id=$1`,[cachedId])).rows[0];
 assert.equal(stored.body,decoded.pages[0].text);assert.equal(stored.parser_version,'docling-v2-text-search');assert.equal(stored.method,'docling-text');assert.deepEqual(stored.warnings,audit.warnings);
 const again=await auditCachedDoclingReplay(item.owner,cachedId);assert.equal(again.visualEvidence.status,'matching');assert.equal(again.decision,'unchanged');
 assert.equal((await applyCachedDoclingReplay(again,again.expectedCurrentVersion,async()=>{throw new Error('unchanged replay must not render');})).action,'unchanged');
 const oldLinkPolicy=process.env.PDF_INTERNAL_LINK_OBSERVATIONS;process.env.PDF_INTERNAL_LINK_OBSERVATIONS='goto-v1';
 try{
  const links=await auditCachedDoclingReplay(item.owner,cachedId);
  assert.equal(links.decision,'eligible');assert.equal(links.visualOnly,true);assert.deepEqual(links.changedPages,[]);
  assert.equal(links.visualEvidence.status,'matching');assert.equal(links.visualEvidence.internalLinks,'not-recorded');
  const linked=await applyCachedDoclingReplay(links,links.expectedCurrentVersion,async()=>{throw Error('existing original pixels must be reused');});
  assert.equal(linked.action,'published');assert.notEqual(linked.currentVersion,links.expectedCurrentVersion);
  const resolved=await kernel.resolveDocumentSource(item.owner,{selectedDocumentTitle:cachedId});if(resolved.status!=='resolved')throw Error('linked source missing');
  const read=await kernel.readPdfInternalLinks(item.owner,resolved.document);
  assert.equal(read.status,'available');assert.equal(read.observations?.semanticVerified,false);
  const unchanged=await auditCachedDoclingReplay(item.owner,cachedId);assert.equal(unchanged.decision,'unchanged');
  assert.equal(unchanged.visualEvidence.internalLinks,'recorded');
  const preserved=(await pool.query<{body:string;warnings:string[];parser_version:string}>(`SELECT p.body,v.warnings,v.parser_version FROM document_texts d
   JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id WHERE d.id=$1`,[cachedId])).rows[0];
  assert.equal(preserved.body,stored.body);assert.deepEqual(preserved.warnings,stored.warnings);assert.equal(preserved.parser_version,stored.parser_version);
 }finally{if(oldLinkPolicy===undefined)delete process.env.PDF_INTERNAL_LINK_OBSERVATIONS;else process.env.PDF_INTERNAL_LINK_OBSERVATIONS=oldLinkPolicy;}
});
