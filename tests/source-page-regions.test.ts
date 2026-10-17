import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,open} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import type {Pool} from 'pg';
import {decodeDoclingResult,indexDoclingPageRegions,DOCLING_PAGE_REGION_LIMITS} from '../lib/kernel/docling-result.ts';
import {doclingPageResultReferences,readDoclingPageRegions} from '../lib/kernel/docling-source-regions.ts';
import {registerDocumentStructure,readDocumentPageRegions,readDocumentPageRegionsForImages,bindStudyPdfPageRegions,unavailableStudyPdfPageRegions,
 STUDY_PDF_PAGE_REGION_LIMITS,COMPLETE_DOCUMENT_SOURCE_LIMITS,DocumentContextError} from '../lib/kernel/document-context.ts';
import {readPdfVisualEvidence,pdfVisualCanonical} from '../lib/kernel/pdf-visual-evidence.ts';
import {prepareDocumentAnswerForPolicy,buildDocumentEvidenceSelectionRequest,buildSelectedDocumentAnswerRequest,pdfPageRegionTransport,
 type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';
import {sourcePageRegionsFixture,fixtureSha} from './fixtures/source-page-regions.ts';

const base=resolve('data');await mkdir(base,{recursive:true});const directory=await mkdtemp(join(base,'source-page-regions-test-'));
process.env.LIBRARY_DIR=directory;
let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw Error('No external calls in region fixture');};
after(async()=>{assert.equal(externalCalls,0);assert.ok(relative(base,directory).startsWith('source-page-regions-test-'));await rm(directory,{recursive:true,force:true});});
const save=async(bytes:Uint8Array)=>{const hash=fixtureSha(bytes);await writeFile(join(directory,hash),bytes);return hash;};

test('region index retains raw roles/order/parent/table/inline provenance without changing serialization or inventing boxes',()=>{
 const f=sourcePageRegionsFixture(),before=JSON.stringify(f.result),index=indexDoclingPageRegions(f.result,1,1);
 assert.deepEqual(index.nodes.map(n=>n.reference),['#/texts/0','#/groups/0','#/texts/3','#/texts/1','#/tables/0','#/texts/2','#/pictures/0']);
 const formula=index.nodes.find(n=>n.reference==='#/texts/3')!;
 assert.deepEqual(formula.path.map(p=>p.reference),['#/groups/0','#/texts/3']);assert.equal(formula.raw.text,'x^2');assert.equal(formula.raw.orig,'x2');
 assert.deepEqual(formula.raw.formatting,{italic:true});assert.deepEqual(formula.raw.parent,{$ref:'#/groups/0'});
 assert.equal(index.nodes[1].membership,'ancestor-reference');assert.equal(index.nodes[1].geometry.status,'unknown');
 const paragraph=index.nodes.find(n=>n.reference==='#/texts/1')!;
 assert.deepEqual(paragraph.geometry,{status:'unknown',reason:'bbox-unavailable'});assert.equal(paragraph.raw.text,'');
 assert.deepEqual(index.nodes.find(n=>n.reference==='#/tables/0')!.raw.data,f.result.document.json_content.tables[0].data);
 assert.equal(JSON.stringify(f.result),before);assert.equal(decodeDoclingResult(f.result,1).pages[0].text,f.body);
 const cycle=structuredClone(f.result);cycle.document.json_content.groups[0].children=[{$ref:'#/groups/0'}];
 assert.throws(()=>indexDoclingPageRegions(cycle,1,1),/cycle/);
 const excessive=structuredClone(f.result);excessive.document.json_content.texts[0].text='x'.repeat(DOCLING_PAGE_REGION_LIMITS.pageBytes);
 assert.throws(()=>indexDoclingPageRegions(excessive,1,1),/page index exceeds/);
});

test('saved CAS reader binds physical page 42 to derived page 1, preserves unknown options and rejects owner/input/map/hash/oversize',async()=>{
 const f=sourcePageRegionsFixture(),source={owner:f.owner,documentId:f.source.documentId,sourceHash:f.source.sourceHash,pageCount:42,physicalPage:42},
  identity={...f.identity,totalPages:42,start:42,end:42,copyIndices:[41]},raw=Buffer.from(JSON.stringify({identity,result:f.result})),hash=await save(raw),
  ref={resultBlobSha256:hash,derivedInputSha256:identity.inputHash,copyIndices:[41],optionsHash:identity.optionsHash};
 const value=await readDoclingPageRegions(source,ref);assert.equal(value.physicalPage,42);assert.equal(value.derivedPage,1);
 assert.equal(value.semanticRelationsVerified,false);assert.equal(value.readingOrderVerified,false);assert.deepEqual(value.inferredRelations,[]);
 assert.equal(value.result.optionsHash,identity.optionsHash);assert.deepEqual(value.result.copyIndices,[41]);
 assert.deepEqual(value.nodes.find(node=>node.reference==='#/texts/0')!.physicalPageNumbers,[42]);
 assert.deepEqual(value.nodes.find(node=>node.reference==='#/groups/0')!.physicalPageNumbers,[]);
 await assert.rejects(readDoclingPageRegions({...source,owner:'foreign'},ref),/owner\/source/);
 await assert.rejects(readDoclingPageRegions(source,{...ref,derivedInputSha256:fixtureSha('wrong input')}),/owner\/source/);
 await assert.rejects(readDoclingPageRegions(source,{...ref,copyIndices:[40]}),/outside saved result/);
 await writeFile(join(directory,hash),Buffer.from('changed'));await assert.rejects(readDoclingPageRegions(source,ref),/checksum/);
 const {optionsHash:unused,...legacy}=identity;void unused;
 const legacyHash=await save(Buffer.from(JSON.stringify({identity:legacy,result:f.result})));
 assert.equal((await readDoclingPageRegions(source,{...ref,resultBlobSha256:legacyHash,optionsHash:null})).result.optionsHash,null);
 const hugeHash=fixtureSha('oversize fixture'),handle=await open(join(directory,hugeHash),'w');
 try{await handle.truncate(DOCLING_PAGE_REGION_LIMITS.rawBytes+1);}finally{await handle.close();}
 await assert.rejects(readDoclingPageRegions(source,{...ref,resultBlobSha256:hugeHash}),/exceeds limit/);
});

/** A registered synthetic relational adapter, not a real PostgreSQL acceptance
 * run. The same factory can be registered in root's isolated PG separately. */
class FixtureDb{
 readonly f=sourcePageRegionsFixture();hidden=false;version=this.f.source.currentVersionId;progress:unknown=this.f.progress;
 visual:unknown=this.f.visual;structure:Record<string,unknown>|undefined;changedAfterRaw=false;progressReads=0;
 async query(sql:string,args:unknown[]=[]):Promise<{rows:Record<string,unknown>[]}>{
  const f=this.f,s=f.source;
  if(sql.includes('FROM document_texts d JOIN document_text_versions v')){
   const ok=!this.hidden&&args[0]===f.owner&&args[1]===s.documentId&&args[2]===this.version&&args[3]===s.sourceVersionId&&args[4]===s.sourceHash&&
    (args[5]===null||args[5]===s.courseId);
   return {rows:ok?[{...s,rawSourceHash:s.sourceHash,name:'Synthetic fixture',origin:'fixture',originKey:s.documentId,
    parserVersion:'fixture-v1',mime:'application/pdf',extractionMethod:'fixture'}]:[]};
  }
  if(sql.startsWith('SELECT page_count'))return {rows:[{page_count:1}]};
  if(sql.includes("raw_value->'batchProvenance'")){
   if(this.changedAfterRaw&&++this.progressReads>1)this.hidden=true;return {rows:[{batch_provenance:this.progress}]};
  }
  if(sql.includes('FROM document_text_pages p'))return {rows:[{page_number:1,evidence_id:f.evidenceId,locator:'page:1',body:f.body}]};
  if(sql.startsWith('SELECT manifest,manifest_sha256,content_sha256'))return {rows:this.visual?[this.visual as Record<string,unknown>]:[]};
  if(sql.startsWith('INSERT INTO document_structures')){
   this.structure={manifest_sha256:args[5],manifest:JSON.parse(args[6] as string),raw_source_hash:args[3]};return {rows:[]};
  }
  if(sql.startsWith('SELECT manifest_sha256 FROM document_structures'))return {rows:this.structure?[this.structure]:[]};
  throw Error('Unexpected fixture query: '+sql);
 }
 db(){return this as unknown as Pick<Pool,'query'>;}
 async register(){for(const blob of this.f.casBlobs)await save(blob.bytes);await registerDocumentStructure(this.db(),this.f.owner,this.f.source,this.f.structure);}
}
const changed=(error:unknown)=>error instanceof DocumentContextError&&error.code==='DOCUMENT_CONTEXT_CHANGED';
test('actual context reader uses registered source/page/manifest/PNG and never promotes producer observations to semantic verification',async()=>{
 const db=new FixtureDb();await db.register();assert.ok(db.structure);
 const f=db.f,before=JSON.stringify(f),result=await readDocumentPageRegions(db.db(),f.owner,f.source,1);
 assert.equal(result.status,'available');if(result.status!=='available')return;
 assert.equal(result.pageEvidenceId,f.evidenceId);assert.equal(result.pageBodySha256,fixtureSha(f.body));
 assert.equal(result.image.sha256,f.pngSha);assert.ok(!('bytes'in result.image));assert.equal(result.visualManifestSha256,f.visual.manifest_sha256);
 assert.equal(result.index.result.resultBlobSha256,f.rawHash);assert.equal(result.index.sourceBindingVerified,true);
 assert.equal(result.index.visibilityVerified,false);assert.equal(result.index.textFaithfulnessVerified,false);
 assert.deepEqual(result.coordinateTransform,{status:'derived',policy:'unrotated-zero-origin-affine-v1',imageOrigin:'TOPLEFT',rounding:'none-continuous-coordinates',
  byCoordOrigin:{TOPLEFT:{scaleX:.01,scaleY:.005,offsetX:0,offsetY:0},BOTTOMLEFT:{scaleX:.01,scaleY:-.005,offsetX:0,offsetY:1}}});
 assert.equal(JSON.stringify(f),before);
 await assert.rejects(readDocumentPageRegions(db.db(),'foreign',f.source,1),changed);
 db.version='new-current';await assert.rejects(readDocumentPageRegions(db.db(),f.owner,f.source,1),changed);
});

test('missing Docling/PNG and ambiguous layouts remain unavailable; corrupt bindings and changing current/provenance cannot be returned',async()=>{
 const db=new FixtureDb();await db.register();const f=db.f;
 db.progress=null;db.visual=null;assert.equal((await readDocumentPageRegions(db.db(),f.owner,f.source,1)).status,'unavailable');
 db.progress=f.progress;assert.equal((await readDocumentPageRegions(db.db(),f.owner,f.source,1)).status,'unavailable');
 db.visual=f.visual;db.progress={...f.progress,identity:{...f.progress.identity,owner:'foreign'}};
 await assert.rejects(readDocumentPageRegions(db.db(),f.owner,f.source,1),/batch source differs/);
 db.progress=f.progress;db.visual={...f.visual,manifest_sha256:fixtureSha('bad manifest')};
 await assert.rejects(readDocumentPageRegions(db.db(),f.owner,f.source,1),/manifest identity differs/);
 db.visual=f.visual;db.changedAfterRaw=true;
 await assert.rejects(readDocumentPageRegions(db.db(),f.owner,f.source,1),changed);
 const source={owner:f.owner,documentId:f.source.documentId,sourceHash:f.source.sourceHash,pageCount:1,physicalPage:1};
 assert.throws(()=>doclingPageResultReferences({...source,pageCount:2},undefined,{...f.layout,resultReferences:[f.reference,{...f.reference,resultBlobSha256:fixtureSha('other result')}]}),/Multiple saved results/);
});

test('PDF region context budget keeps whole first-fit observations, later small items and existing unavailable reasons',async()=>{
 const owner='regions-budget-owner',dbs:FixtureDb[]=[],images:Awaited<ReturnType<typeof readPdfVisualEvidence>>['images']=[];
 for(const [i,padding]of [14000,14000,22000,0,40000].entries()){
  const sourceHash=sourcePageRegionsFixture().source.sourceHash,source={documentId:`budget-doc-${i}`,currentVersionId:`budget-version-${i}`,
   sourceVersionId:`budget-source-${i}`,sourceHash,courseId:''},f=sourcePageRegionsFixture(source,owner,{pageEvidenceId:`budget-evidence-${i}`});
  // Synthetic producer text makes whole observations different sizes. It is
  // never used to rewrite the registered body or claim transcription fidelity.
  f.result.document.json_content.texts[1].orig='x'.repeat(padding)||'small orig';
  f.raw=Buffer.from(JSON.stringify({identity:f.identity,result:f.result}));f.rawHash=fixtureSha(f.raw);
  f.reference.resultBlobSha256=f.rawHash;f.progress.batches[0].resultHash=f.rawHash;
  f.visual.manifest_sha256=fixtureSha(pdfVisualCanonical(f.visual.manifest));
  f.visual.content_sha256=fixtureSha(pdfVisualCanonical(f.visual.manifest.content));
  f.casBlobs=[{sha256:f.rawHash,bytes:f.raw},{sha256:f.pngSha,bytes:f.png}];
  const db=new FixtureDb();Object.assign(db.f,f);db.version=source.currentVersionId;db.progress=f.progress;db.visual=f.visual;
  await db.register();dbs.push(db);
  images.push((await readPdfVisualEvidence(db.db(),owner,source,[f.evidenceId],undefined,{pageAssetsOnly:true})).images[0]);
 }
 const originals=await Promise.all(dbs.map(async(db,i)=>bindStudyPdfPageRegions(images[i],await readDocumentPageRegions(db.db(),owner,db.f.source,1)))),
  canonical=(value:unknown)=>pdfVisualCanonical(value),size=(value:unknown)=>Buffer.byteLength(canonical(value)),
  minimum=originals.map(o=>o.status==='available'?unavailableStudyPdfPageRegions(o,'context-observation-byte-limit'):o);
 assert.deepEqual(originals.map(o=>o.status),['available','available','available','available','unavailable']);
 assert.equal(originals[4].reason,'page-observation-byte-limit');
 const afterFirstTwo=minimum.map((o,i)=>i<2?originals[i]:o);
 assert.ok(size(afterFirstTwo)<=STUDY_PDF_PAGE_REGION_LIMITS.contextBytes);
 assert.ok(size(afterFirstTwo.map((o,i)=>i===2?originals[i]:o))>STUDY_PDF_PAGE_REGION_LIMITS.contextBytes);
 assert.ok(size(afterFirstTwo.map((o,i)=>i===3?originals[i]:o))<=STUDY_PDF_PAGE_REGION_LIMITS.contextBytes);
 const inputSnapshot=images.map(image=>({...image,bytes:Buffer.from(image.bytes)})),bodies=dbs.map(db=>db.f.body),
  router={query:async(sql:string,args:unknown[]=[])=>{const db=dbs.find(d=>args.some(a=>
   a===d.f.source.documentId||a===d.f.source.currentVersionId||a===d.f.source.sourceVersionId));
   if(!db)throw Error('Foreign budget fixture query');return db.query(sql,args);}} as unknown as Pick<Pool,'query'>,
  result=await readDocumentPageRegionsForImages(router,owner,images),added=result.images.map(image=>image.pageRegions);
 assert.deepEqual(added.map(o=>o?.status),['available','available','unavailable','available','unavailable']);
 for(const i of [0,1,3])assert.deepEqual(added[i],originals[i],'whole available observation must remain byte-identical');
 assert.equal(added[2]?.reason,'context-observation-byte-limit');assert.equal(added[2]?.payload,undefined);
 assert.equal(added[2]?.originalObservationSha256,originals[2].originalObservationSha256);
 assert.deepEqual(added[4],originals[4],'page-level unavailable reason/hash must remain intact');
 assert.equal(result.pdfPageRegionReads[4].reason,'page-observation-byte-limit');assert.ok(size(added)<=STUDY_PDF_PAGE_REGION_LIMITS.contextBytes);
 assert.deepEqual(result.images.map(({pageRegions:unused,...image})=>{void unused;return image;}),inputSnapshot);
 assert.deepEqual(images,inputSnapshot);assert.deepEqual(dbs.map(db=>db.f.body),bodies);
});

test('PDF regions study input: bound full observations survive actual builders; optional bytes never displace original evidence or enter local support',async()=>{
 const db=new FixtureDb();await db.register();const f=db.f,
  visual=await readPdfVisualEvidence(db.db(),f.owner,f.source,[f.evidenceId],undefined,{pageAssetsOnly:true}),image=visual.images[0],
  context:DocumentAnswerContext={anchors:[{id:`pg:${f.source.currentVersionId}:1`,document_id:f.source.documentId,
   source_version_id:f.source.sourceVersionId,source_hash:f.source.sourceHash,course_id:'',name:'Synthetic fixture',origin:'fixture',origin_key:f.source.documentId,
   body:f.body,locator:'page:1',page_number:1,evidence_id:f.evidenceId,parser_version:'fixture-v1',score:1,evidence_body:'full-page'}],
   parents:[],images:[image],sourceContentIsUntrusted:true},question='What does the supplied page report?',
  policy={scope:'application' as const,evidenceSelection:'select-then-answer' as const},
  settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:1000},
  basePrepared=prepareDocumentAnswerForPolicy(question,context,policy),extra=await readDocumentPageRegionsForImages(db.db(),f.owner,[image]),
  enriched={...context,...extra},prepared=prepareDocumentAnswerForPolicy(question,enriched,policy),
  packet=(r:{input:unknown[]})=>JSON.parse((r.input.at(-1) as {content:Array<{text:string}>}).content[0].text),
  selection=buildDocumentEvidenceSelectionRequest(prepared,settings,policy),ids=[prepared.quoteUnits.find(q=>q.selectable)!.id,'i0'],
  generation=buildSelectedDocumentAnswerRequest(prepared,ids,settings,policy),observed=packet(generation).evidence.find((e:{id:string})=>e.id==='i0').pageRegions;
 assert.deepEqual(prepared.quoteUnits,basePrepared.quoteUnits);assert.deepEqual(enriched.images[0].bytes,image.bytes);
 assert.equal(enriched.anchors[0].body,f.body);assert.notEqual(prepared.fingerprint,basePrepared.fingerprint);
 assert.equal(packet(selection).evidence.find((e:{id:string})=>e.id==='i0').pageRegions.observationSha256,observed.observationSha256);
 assert.equal(observed.payload.index.result.resultBlobSha256,f.rawHash);assert.equal(observed.payload.index.nodes.length,7);
 assert.equal(observed.payload.index.visibilityVerified,false);assert.equal(observed.payload.index.semanticRelationsVerified,false);
 assert.equal(observed.payload.index.nodes[0].raw.prov[0].bbox.coord_origin,'BOTTOMLEFT');
 assert.equal(observed.payload.coordinateTransform.byCoordOrigin.BOTTOMLEFT.scaleY,-.005);
 assert.equal(pdfPageRegionTransport(prepared,generation)!.images[0].transport,'available');
 const local=prepareDocumentCitationAudit(question,enriched,{inputFingerprint:prepared.fingerprint,quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,
  providerSelections:{status:'answered',message:'',claims:[{text:'Synthetic observation.',citations:[{id:'i0'}]}]},claimIndex:0,unitPolicy:'author-image-caption-v1'});
 assert.equal(JSON.stringify(buildDocumentCitationAuditRequest(local.packet)).includes('pageRegions'),false,'local checks receive the original PNG, not the observation');
 const bad=structuredClone(enriched);if(!('pageRegions'in bad.images[0]))throw Error('Missing synthetic observation');
 bad.images[0].pageRegions!.binding.source.sourceHash=fixtureSha('foreign');assert.throws(()=>prepareDocumentAnswerForPolicy(question,bad,policy));
 const frame=structuredClone(enriched);if(!('provenance'in frame.images[0]))throw Error('Missing synthetic frame');
 (frame.images[0].provenance as typeof image.provenance).rotation=90;assert.throws(()=>prepareDocumentAnswerForPolicy(question,frame,policy));
 const read=await readDocumentPageRegions(db.db(),f.owner,f.source,1);if(read.status!=='available')throw Error('Missing registered fixture');
 const large=structuredClone(read);large.index.nodes[0].raw.text='x'.repeat(STUDY_PDF_PAGE_REGION_LIMITS.pageBytes);
 const unavailable=bindStudyPdfPageRegions(image,large);assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.payload,undefined);
 assert.equal(unavailable.reason,'page-observation-byte-limit');assert.ok(unavailable.originalObservationByteLength>STUDY_PDF_PAGE_REGION_LIMITS.pageBytes);
 const baseRequest=buildSelectedDocumentAnswerRequest(basePrepared,ids,settings,policy),nonImage=(r:unknown)=>Buffer.byteLength(JSON.stringify(r,(k,v)=>k==='image_url'?'data:image/png;base64,':v)),
  padding=COMPLETE_DOCUMENT_SOURCE_LIMITS.requestInputTokens-COMPLETE_DOCUMENT_SOURCE_LIMITS.framingTokens-3-nonImage(baseRequest)-10,
  fullContext={...enriched,anchors:enriched.anchors.map(a=>({...a,parser_warnings:['x'.repeat(padding)]}))},
  full=prepareDocumentAnswerForPolicy(question,fullContext,policy),fullFingerprint=full.fingerprint,fullRequest=buildSelectedDocumentAnswerRequest(full,ids,settings,policy);
 assert.equal(packet(fullRequest).evidence.find((e:{id:string})=>e.id==='i0').pageRegions,undefined);
 assert.equal(full.fingerprint,fullFingerprint);assert.equal(pdfPageRegionTransport(full,fullRequest)!.images[0].transport,'omitted-request-capacity');
 assert.equal(pdfPageRegionTransport(full,fullRequest)!.images[0].reason,'request-input-limit');
 assert.deepEqual(packet(fullRequest).quoteUnits,packet(baseRequest).quoteUnits);
 assert.deepEqual((fullRequest.input.at(-1)!.content as any[]).filter(p=>p.type==='input_image'),(generation.input.at(-1)!.content as any[]).filter(p=>p.type==='input_image'));
 // Fresh no-data manifest: absence is not a false region claim or changed wire.
 db.progress=null;const manifest:any=structuredClone(f.visual.manifest);manifest.content.layout={status:'unavailable',regions:[],pageSizes:[]};
 db.visual={manifest,manifest_sha256:fixtureSha(pdfVisualCanonical(manifest)),content_sha256:fixtureSha(pdfVisualCanonical(manifest.content))};
 const noneImage=(await readPdfVisualEvidence(db.db(),f.owner,f.source,[f.evidenceId],undefined,{pageAssetsOnly:true})).images[0],
  noneContext={...context,images:[noneImage]},none=await readDocumentPageRegionsForImages(db.db(),f.owner,[noneImage]),
  before=prepareDocumentAnswerForPolicy(question,noneContext,policy),after=prepareDocumentAnswerForPolicy(question,{...noneContext,...none},policy);
 assert.equal(none.pdfPageRegionReads[0].status,'unavailable');assert.equal(before.fingerprint,after.fingerprint);
 assert.equal(JSON.stringify(buildDocumentEvidenceSelectionRequest(before,settings,policy)),JSON.stringify(buildDocumentEvidenceSelectionRequest(after,settings,policy)));
 assert.equal(pdfPageRegionTransport(after,buildSelectedDocumentAnswerRequest(after,ids,settings,policy))!.images[0].transport,'unavailable-reader');
 assert.equal(externalCalls,0);
});
