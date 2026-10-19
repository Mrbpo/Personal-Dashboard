import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,open} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import type {Pool} from 'pg';
import {decodeDoclingResult,indexDoclingPageRegions,DOCLING_PAGE_REGION_LIMITS} from '../lib/kernel/docling-result.ts';
import {doclingPageResultReferences,readDoclingPageRegions} from '../lib/kernel/docling-source-regions.ts';
import {registerDocumentStructure,readDocumentPageRegions,DocumentContextError} from '../lib/kernel/document-context.ts';
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
