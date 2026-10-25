import{test,after}from'node:test';import assert from'node:assert/strict';
import{randomUUID,createHash}from'node:crypto';import{writeFile}from'node:fs/promises';import{resolve}from'node:path';
import{PDFDocument}from'pdf-lib';import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{preparePdfVisualEvidence}from'../lib/kernel/pdf-visual-evidence.ts';import{saveBlob}from'../lib/library.ts';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Snapshot regression prohibits external calls');};
after(async()=>{assert.equal(calls,0);if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});

test('one SQL snapshot transfers metadata once while every original page and publication lock retain recall/provenance',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),tag=randomUUID(),owner='snapshot-owner-'+tag,id='snapshot-doc-'+tag,
  pdf=await PDFDocument.create();pdf.addPage([100,200]);pdf.addPage([100,200]);const bytes=await pdf.save(),sourceHash=sha(bytes),
  needles=['firstunseenneedle'+tag.replace(/[^a-z]/g,''),'secondunseenneedle'+tag.replace(/[^a-z]/g,'')],optionsHash=sha('synthetic snapshot options'),
  bodies=['Stored first-page observation.','Stored second-page observation.'],
  result={status:'success',document:{json_content:{pages:{1:{page_no:1},2:{page_no:2}},
   body:{children:[{$ref:'#/texts/0'},{$ref:'#/texts/1'}]},texts:bodies.map((text,i)=>({self_ref:'#/texts/'+i,
    parent:{$ref:'#/body'},label:'paragraph',text,orig:needles[i],prov:[{page_no:i+1}]}))}}},
  identity={owner,documentId:id,sourceHash,totalPages:2,optionsHash,start:1,end:2,inputHash:sourceHash,copyIndices:[0,1]},
  raw=Buffer.from(JSON.stringify({identity,result})),resultHash=await saveBlob(raw),
  progress={schema:1,identity:{owner,documentId:id,sourceHash,totalPages:2,optionsHash},batchSize:2,
   batches:[{start:1,end:2,resultHash,inputHash:sourceHash,copyIndices:[0,1]}]},
  layout={status:'available' as const,regions:[],pageSizes:[1,2].map(pageNumber=>({pageNumber,width:100,height:200})),
   resultReferences:[{resultBlobSha256:resultHash,derivedInputSha256:sourceHash,copyIndices:[0,1]}]},
  png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=','base64'),
  visuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout},async()=>png);
 // Synthetic plumbing only; these declared texts do not measure PDF fidelity.
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Synthetic snapshot '+tag,hash:sourceHash,mime:'application/pdf',origin:'snapshot-fixture',originKey:id},
  bodies.map((text,i)=>({pageNumber:i+1,locator:'page:'+(i+1),text})),{parserVersion:'synthetic-orig-snapshot-v1',batchProvenance:progress,pdfVisuals:visuals});
 const wire:Array<Array<{page_number:number;progress:unknown;layout:unknown}>>=[],db=pool as unknown as{query:(...args:unknown[])=>Promise<{rows:typeof wire[number]}>},original=db.query;
 db.query=function(...args){const pending=original.apply(pool,args);
  return pending.then(result=>{if(typeof args[0]==='string'&&args[0].startsWith('SELECT d.id document_id,')&&args[0].includes('search_hint_provenance'))wire.push(structuredClone(result.rows));return result;});};
 try{await kernel.rebuildDocumentSearch(owner,id);}finally{db.query=original;}
 assert.equal(wire.length,1);assert.deepEqual(wire[0].map(row=>row.page_number),[1,2]);
 assert.deepEqual(wire[0][0].progress,progress);assert.deepEqual(wire[0][0].layout,layout);
 assert.equal(wire[0][1].progress,null);assert.equal(wire[0][1].layout,null,'second page does not duplicate the full layout on the wire');
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Synthetic snapshot '+tag});
 if(resolution.status!=='resolved')throw Error('Fixture source unavailable');const source=resolution.document;
 for(const [i,needle]of needles.entries()){
  const hits=await kernel.searchDocumentText(owner,needle,{documentId:id,strict:true,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,evidenceBody:'full-page'});
  assert.equal(hits.length,1);assert.equal(hits[0].page_number,i+1);assert.equal(hits[0].body,bodies[i]);assert.equal(hits[0].retrieval_hint?.authority,'unverified-retrieval-hint');
 }
 assert.equal((await kernel.refreshDocumentOrigSearchHints(owner,source,2)).status,'unchanged','explicit non-first page keeps its own metadata payload');
 await assert.rejects(kernel.rebuildDocumentSearch('foreign',id));
 await assert.rejects(kernel.refreshDocumentOrigSearchHints(owner,{...source,currentVersionId:'stale'},2));
 const path=resolve(process.env.LIBRARY_DIR||'./data/library',resultHash);await writeFile(path,'corrupt');
 try{await assert.rejects(kernel.refreshDocumentOrigSearchHints(owner,source,2),/checksum/);}finally{await writeFile(path,raw);}
});
